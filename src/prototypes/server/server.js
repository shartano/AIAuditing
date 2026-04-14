const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const supabase = require('./supabaseClient');
const multer = require('multer');

require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());


app.get('/', async (req, res) => {
    return res.status(200).json("Welcome to Crepancy!");
})


const authorize = (req, res, next) => {
    const token = req.header("token");
    if(!token){ return res.status(403).json("Not Authorized.")};

    try{
        const verify = jwt.verify(token, process.env.JWT_SECRET)
        req.user = verify.user_id;
        next()
    } catch (err) {
        console.log("AUTH FAIL:", err.message);
        return res.status(403).json("Token is not valid");
    }
    };

const upload = multer({ // --- Multer memory storage ---
    storage: multer.memoryStorage(),
    limits: {
        files: 100,
        fileSize: 2 * 1024 * 1024, // 2MB per frame (tune as needed)
        fieldSize: 200 * 1024 // metadata size cap
    },
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
        if (!ok) return cb(new Error('Invalid file type'), false);
        cb(null, true);
    }
});

app.post('/scan/batch', authorize, upload.array('frames'), async (req, res) => {
    try {
        const files = req.files || [];
        const metadataRaw = req.body?.metadata;

        console.log("---- SCAN BATCH RECEIVED ----");
        console.log("User:", req.user);
        console.log("Files:", req.files?.length);
        console.log("Body keys:", Object.keys(req.body));
        console.log("Metadata raw:", req.body?.metadata);
        console.log("Sizes:", (req.files || []).map(f => f.size));
        console.log("Total bytes:", (req.files || []).reduce((s, f) => s + (f.size || 0), 0));

        // --- Validation ---
        if (!files.length) return res.status(400).json({ error: 'No frames uploaded' });
        
        let metadata = {};
        try { metadata = JSON.parse(metadataRaw || '{}'); } 
        catch (e) { return res.status(400).json({ error: 'Invalid metadata' }); }

        const scanId = metadata.scanId;
        const userId = req.user;
        if (!scanId) return res.status(400).json({ error: 'Missing scanId' });

        console.log(`Processing Scan: ${scanId} | Files: ${files.length}`);


        const uploadPromises = files.map(async (file, index) => {
            const frameNumber = String(index).padStart(5,'0');
            const filePath = `${scanId}/frame_${frameNumber}.jpg`; 

            const { error } = await supabase
                .storage
                .from('audit-inputs') 
                .upload(filePath, file.buffer, {
                    contentType: file.mimetype,
                    upsert: true
                });

            if (error) throw error;
            return filePath;
        });

        await Promise.all(uploadPromises);
        console.log(`Successfully uploaded ${files.length} frames to folder: ${scanId}`);

        let pipelineResult = null;
        let auditResponse = null;

        try{
        
            const PIPELINE_URL = process.env.ML_PIPELINE_URL; // Add to Railway variable
            const pipelineResponse = await fetch(PIPELINE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scan_id: scanId,
                    marker_id: 22,
                    marker_size_m: 0.096
                })
            });

            const responseText = await pipelineResponse.text();

            if (!pipelineResponse.ok) {
                throw new Error(`Pipeline failed (${pipelineResponse.status}): ${responseText}`);
            }

            try {
                pipelineResult = JSON.parse(responseText);
                console.log("Pipeline Job Started:", pipelineResult);
            } catch (e) {
                throw new Error(`Pipeline returned invalid JSON: ${responseText}`);
            }
        } catch (pipelineErr) {
            console.error("Failed to trigger pipeline:", pipelineErr.message);
            // Decide if you want to return an error to the frontend or just log it
        } 
    

        try{
            if(pipelineResult){
                console.log("userID here" , userId);
                const {job_id,  status } = pipelineResult;
                const dbResponse = await db.query('INSERT INTO audits ( created_by, scan_id, job_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
                    [ userId, scanId, job_id, status]
                )
                auditResponse = dbResponse.rows[0];
            }
            
        }catch(err){
            console.error("Database Insert Error:", err.message);
        }
        

        return res.status(200).json({ 
            success: true, 
            message: "Upload complete", 
            audit: auditResponse 
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});


app.post('/pipeline/callback', async (req, res) => {
/* 1. Security: Check for the secret header
    const receivedSecret = req.header("x-pipeline-secret");
    if (!receivedSecret || receivedSecret !== process.env.PIPELINE_SECRET) {
        console.warn("Unauthorized callback attempt");
        return res.status(403).json({ error: "Unauthorized" });
    }
*/
    // check for json content type
      if (!req.is("application/json")) {
        return res.status(415).json({ error: "Expected application/json" });
    }
    const body = req.body || {};
    const { scan_id, job_id, status } = body;

    if (!scan_id || !status) {
        return res.status(400).json({ error: "Missing scan_id or status" });
    }

    console.log(`Callback received for Scan ${scan_id}: ${status}`);

    let finalAuditData = null;
    
    try {
        if (status === 'success' || status === 'completed') {
            const jsonPath = `${scan_id}/scene.json`;
            console.log(`Downloading results from: ${jsonPath}`);

            const { data, error } = await supabase
                .storage
                .from("audit-outputs") 
                .download(jsonPath);

            if (error) {
                console.error("Supabase Download Error:", error.message);
            } else if (data) {
                const textData = await data.text();
                finalAuditData = JSON.parse(textData);
                console.log("JSON Report retrieved and parsed.");
            }
        }
        const result = await db.query(
            `UPDATE audits 
             SET status = $1, 
                 audit_data = $2,
                 job_id = COALESCE(job_id, $4) 
             WHERE scan_id = $3 
             RETURNING *`,
            [status, finalAuditData, scan_id, job_id]
        );

        if (result.rows.length === 0) {
            console.error(`Audit not found for scan_id: ${scan_id}`);
            return res.status(404).json({ error: "Audit record not found" });
        }

        console.log("Audit updated successfully.");
        return res.json({ success: true, audit: result.rows[0] });

    } catch (err) {
        console.error("Callback Error:", err.message);
        return res.status(500).json({ error: "Server error processing callback" });
    }
});


app.post('/register', async (req, res) => {
    try {
        const { email, password, first_name, last_name, role } = req.body;
        const checkUser = await db.query('SELECT * FROM users WHERE email=$1', [email])
        if(checkUser.rows.length > 0){return res.status(401).json("User already exsists.")}

        const saltRound = 10;
        const hashed_password = await bcrypt.hash(password, saltRound);

        const newUser = await db.query(
            'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES ($1, $2,$3, $4,$5) RETURNING *',
            [email, hashed_password, first_name, last_name, role || 'general']
        );

        const token = jwt.sign({ user_id: newUser.rows[0].user_id }, process.env.JWT_SECRET, { expiresIn: "23h" });
        res.json({ token, user_role: newUser.rows[0].role });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
} )

app.post("/login", async (req, res) => {
    try{
        const {email, password} = req.body;
        const user = await db.query('SELECT * FROM users WHERE email = $1 ', [email])

        if(user.rows.length === 0){ 
            return res.status(401).json("Password or Email incorrect.")
        }

        const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);
        if(!validPassword){
            return res.status(401).json("Password or Email incorrect.")
        }
        const token = jwt.sign({ user_id: user.rows[0].user_id }, process.env.JWT_SECRET, { expiresIn: "23h" });

        res.json({ token, user_role: user.rows[0].role });

    }catch(err){
        console.error(err);
        res.status(500).json("Server error");
    }
})

app.get('/auth/me', authorize ,async (req, res) => {
    try{
        const user = await db.query(
            'SELECT user_id, email, first_name, last_name, role, created_at FROM users WHERE user_id = $1',
            [req.user]
        )
        
        res.json({user: user.rows[0]});

    }catch(err){
        console.error(err);
        res.status(500).json("Server Error");
    }
}
)

app.get('/audits/history', authorize, async (req, res) => {
  try {
    const audits = await db.query(
      `
      WITH numbered AS (
        SELECT
          audit_id,
          status,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY created_by ORDER BY created_at ASC) AS audit_number
        FROM audits
        WHERE created_by = $1
      )
      SELECT
        audit_id,
        status,
        ('Audit ' || audit_number) AS room_name,
        TO_CHAR(created_at, 'YYYY-MM-DD') AS created_date
      FROM numbered
      ORDER BY created_at DESC;
      `,
      [req.user]
    );

    res.json(audits.rows);
  } catch (err) {
    console.error("History Error:", err.message);
    res.status(500).json("Server error fetching history");
  }
}); 

app.get('/audits/:id/result', authorize, async (req, res) => {
    try {
        const { id } = req.params;

        const audit = await db.query(
            'SELECT audit_data FROM audits WHERE audit_id = $1 AND created_by = $2',
            [id, req.user]
        );

        if (audit.rows.length === 0) {
            return res.status(404).json("Audit not found.");
        }

        // Return the JSON object directly
        res.json(audit.rows[0].audit_data);

    } catch (err) {
        console.error(err.message);
        res.status(500).json("Server error fetching audit details");
    }
});

const PORT = process.env.PORT || 3000; // Use the env variable if available

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`The server is running on port ${PORT}`);
    });
}

module.exports = app;

