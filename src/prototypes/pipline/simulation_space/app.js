import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/* --- 1. DATA MANAGEMENT --- */

// SAMPLE: Realistic Public Accessibility Bathroom Scenario
// Just a placeholder for actual scan data, users are still able to upload their own JSON files
let currentScanData = {
    "generated_at": "2025-11-28T09:15:00",
    "reference_marker_id": 101,
    "marker_ids_seen": [101, 102, 103],
    "markers_world": {
        // Mock markers roughly in corners
        "101": { "position": [0.0, 0.0, 0.0], "x_axis": [1.0, 0.0, 0.0], "y_axis": [0.0, 1.0, 0.0], "z_axis": [0.0, 0.0, 1.0] },
        "102": { "position": [2.2, 0.0, 0.0], "x_axis": [0.0, 1.0, 0.0], "y_axis": [-1.0, 0.0, 0.0], "z_axis": [0.0, 0.0, 1.0] },
        "103": { "position": [0.0, 2.5, 0.0], "x_axis": [1.0, 0.0, 0.0], "y_axis": [0.0, 1.0, 0.0], "z_axis": [0.0, 0.0, 1.0] }
    },
    "room_box_from_markers_m": {
        // A 2.2m x 2.5m room, 2.6m high
        "min": [0.0, 0.0, 0.0],
        "max": [2.2, 2.5, 2.6],
        "size": [2.2, 2.5, 2.6]
    },
    "detected_objects": [
        {
            "id": "door_01",
            "type": "door",
            // Centered on the front wall (Y=0)
            "position": [1.1, 0.02, 1.05],
            "rotation": [0, 0, 0],
            "dimensions": { "width": 0.95, "height": 2.1, "depth": 0.05 }
        },
        {
            "id": "btn_open",
            "type": "button",
            // Next to door, height 1.0m
            "position": [1.75, 0.02, 1.0],
            "rotation": [0, 0, 0]
        },
        {
            "id": "toilet_01",
            "type": "toilet",
            // Back wall (Y=2.5), near left corner
            "position": [0.45, 2.25, 0.0],
            "rotation": [0, 0, 0]
        },
        {
            "id": "grab_side",
            "type": "grab_bar",
            // Side wall (X=0), Height 0.85m
            "position": [0.05, 2.25, 0.85],
            "rotation": [0, 0, 0], // Aligned with Y axis
            "length": 0.9,
            "radius": 0.04
        },
        {
            "id": "grab_rear",
            "type": "grab_bar",
            // Rear wall (Y=2.5), Height 0.85m
            "position": [0.45, 2.45, 0.85],
            "rotation": [0, 1.57, 0], // Rotated to align with X axis
            "length": 0.6,
            "radius": 0.04
        },
        {
            "id": "sink_01",
            "type": "sink",
            // Right wall (X=2.2)
            "position": [2.0, 1.5, 0.8],
            "rotation": [0, 0, -1.57] // Facing into room
        },
        {
            "id": "garbage_01",
            "type": "garbage",
            "position": [2.0, 0.4, 0.0], // Floor near door
            "rotation": [0, 0, 0]
        }
    ],
    "audit_annotations": [
        { "position": [1.1, 0.02, 1.5], "text": "Door Width: 0.95m\n(Compliant)", "status": "ok" },
        { "position": [1.75, 0.02, 1.1], "text": "Button H: 1.0m\n(Compliant)", "status": "ok" },
        { "position": [0.05, 2.25, 0.9], "text": "Grab Bar H: 0.85m\n(Compliant)", "status": "ok" }
    ]
};

/* --- 2. THREE.JS SETUP --- */
const scene = new THREE.Scene();
const gridHelper = new THREE.GridHelper(10, 10, 0x333333, 0x111111);
gridHelper.rotation.x = Math.PI / 2;
scene.add(gridHelper);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.up.set(0, 0, 1);
camera.position.set(3.5, -2.5, 3.5); // Adjusted camera angle for better room view
camera.lookAt(1.1, 1.25, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1a1a);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(1.1, 1.25, 0); // Target center of the room

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, -5, 10);
scene.add(dirLight);

// Layers
const groups = {
    bounds: new THREE.Group(),
    markers: new THREE.Group(),
    objects: new THREE.Group(),
    dimensions: new THREE.Group(),
    annotations: new THREE.Group()
};
// Add all groups to scene
Object.values(groups).forEach(g => scene.add(g));

/* --- 3. HELPER FUNCTIONS --- */

function createTextSprite(message, color = "white", fontSize = 24, border = false) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = `Bold ${fontSize}px Arial`;
    ctx.font = font;
    const metrics = ctx.measureText(message);
    canvas.width = metrics.width + 20;
    canvas.height = fontSize + 20;

    ctx.font = font; // reset after resize
    if (border) {
        ctx.fillStyle = border === 'red' ? "rgba(200, 50, 50, 0.8)" : "rgba(50, 150, 50, 0.8)";
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        ctx.roundRect(0, 0, canvas.width, canvas.height, 10);
        ctx.fill();
        ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    const scaleFactor = 0.005;
    sprite.scale.set(canvas.width * scaleFactor, canvas.height * scaleFactor, 1);
    return sprite;
}

function createDimension(startPoint, endPoint, labelText) {
    const group = new THREE.Group();
    const material = new THREE.LineDashedMaterial({ color: 0xffff00, dashSize: 0.1, gapSize: 0.05 });
    const points = [startPoint, endPoint];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    group.add(line);

    const midPoint = new THREE.Vector3().addVectors(startPoint, endPoint).multiplyScalar(0.5);
    const sprite = createTextSprite(labelText, "#ffff00", 40);
    sprite.position.copy(midPoint);
    sprite.position.z += 0.05;
    group.add(sprite);
    return group;
}

// --- OBJECT BUILDERS (add more functions for other objects) ---

function buildToilet(pos) {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0xeeeeee });
    const tank = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.2), material);
    tank.position.set(0, -0.25, 0.7);
    tank.rotation.x = Math.PI / 2;
    group.add(tank);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.15, 0.4, 16), material);
    bowl.rotation.x = -Math.PI / 2;
    bowl.position.set(0, 0.1, 0.2);
    group.add(bowl);
    const seat = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 20), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
    seat.position.set(0, 0.1, 0.42);
    group.add(seat);
    group.position.set(...pos);
    return group;
}

function buildGrabBar(pos, length, rotation) {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
    // Bar alignment defaults to Y axis (Geometry default for cylinder is Y-up, we rotate Z to lay flat)
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, length, 12), material);

    // Check rotation logic: 
    // If we want it horizontal, we usually rotate X or Z. 
    // Here, we assume the input 'rotation' array handles the orientation.
    // But let's center geometry on origin so rotation works well.
    bar.rotation.x = Math.PI / 2; // Default to lying along Y axis relative to group
    group.add(bar);

    const mountGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.05);
    const m1 = new THREE.Mesh(mountGeo, material);
    m1.position.y = -length / 2; m1.rotation.x = Math.PI / 2; group.add(m1);
    const m2 = new THREE.Mesh(mountGeo, material);
    m2.position.y = length / 2; m2.rotation.x = Math.PI / 2; group.add(m2);

    group.position.set(...pos);
    group.rotation.set(...rotation);
    return group;
}

function buildDoor(pos, dims) {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown wood
    const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(dims.width, dims.depth, dims.height), material);
    group.add(doorMesh);

    // Handle
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15), new THREE.MeshStandardMaterial({ color: 0xC0C0C0 }));
    handle.rotation.z = Math.PI / 2;
    handle.position.set(dims.width / 2 - 0.1, -dims.depth, 0); // Offset handle
    group.add(handle);

    group.position.set(...pos);
    return group;
}

function buildSink(pos) {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    // Basin
    const basin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.15), material);
    group.add(basin);
    // Trap (Cylinder underneath)
    const trap = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4), new THREE.MeshStandardMaterial({ color: 0xaaaaaa }));
    trap.position.set(0, 0, -0.2);
    trap.rotation.x = Math.PI / 2;
    group.add(trap);

    group.position.set(...pos);
    return group;
}

function buildButton(pos) {
    const group = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.25), new THREE.MeshStandardMaterial({ color: 0xaaaaaa }));
    group.add(plate);
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.04), new THREE.MeshStandardMaterial({ color: 0x0000ff }));
    btn.rotation.x = Math.PI / 2;
    btn.position.y = -0.02;
    group.add(btn);
    group.position.set(...pos);
    return group;
}

function buildGarbage(pos) {
    const group = new THREE.Group();
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0x555555 }));
    can.rotation.x = Math.PI / 2;
    can.position.z = 0.2;
    group.add(can);
    group.position.set(...pos);
    return group;
}

/* --- 4. RENDER LOGIC --- */

function renderScene(data) {
    // CLEAR OLD ITEMS
    Object.values(groups).forEach(g => {
        while (g.children.length > 0) g.remove(g.children[0]);
        // Reset position to 0 before calculating new offset
        g.position.set(0, 0, 0);
    });

    // --- Z-OFFSET CALCULATION ---
    // 1. Find where the floor is currently (min.z)
    // 2. Calculate the offset needed to bring it to 0
    let zOffset = 0;
    if (data.room_box_from_markers_m) {
        // E.g, If floor is at -0.52, we need to move everything up by +0.52
        zOffset = -data.room_box_from_markers_m.min[2];
    }

    // 3. Apply this offset to ALL container groups
    // This acts like an elevator, lifting the whole room to the ground floor
    Object.values(groups).forEach(g => {
        g.position.z = zOffset;
    });

    // Bounds to create room box
    if (data.room_box_from_markers_m) {
        const min = new THREE.Vector3(...data.room_box_from_markers_m.min);
        const max = new THREE.Vector3(...data.room_box_from_markers_m.max);

        // Calculate actual scanned height
        let scannedHeight = max.z - min.z;
        const defaultCeiling = 2.5;

        // If scanned height is suspiciously low (e.g. just a floor scan), force visual walls to defaultCeiling height
        // Otherwise use the actual scanned height
        const roomH = scannedHeight < 1.5 ? defaultCeiling : scannedHeight;

        const size = new THREE.Vector3(max.x - min.x, max.y - min.y, roomH);

        // Calculate center based on the derived roomH
        // This ensures the box sits on top of the min.z floor (the grid)
        const center = new THREE.Vector3(
            (max.x + min.x) / 2,
            (max.y + min.y) / 2,
            min.z + (roomH / 2)
        );

        // Add floor
        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(size.x, size.y),
            new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide })
        );
        floor.position.set(center.x, center.y, min.z);
        groups.bounds.add(floor);

        // Add walls
        const wallGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
        const wallMesh = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial({
            color: 0x6495ED,
            transparent: true,
            opacity: 0.3,
            depthWrite: false
        }));
        wallMesh.position.copy(center);
        groups.bounds.add(wallMesh);

        // Add edges
        const edges = new THREE.EdgesGeometry(wallGeo);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x88ccff }));
        line.position.copy(center);
        groups.bounds.add(line);

        const dim1 = createDimension(new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z), `${size.x.toFixed(2)}m`);
        groups.dimensions.add(dim1);
        const dim2 = createDimension(new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z), `${size.y.toFixed(2)}m`);
        groups.dimensions.add(dim2);
    }

    // Markers
    if (data.markers_world) {
        Object.values(data.markers_world).forEach(m => {
            const geometry = new THREE.PlaneGeometry(0.15, 0.15);
            const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(geometry, material);
            const matrix = new THREE.Matrix4();
            matrix.set(m.x_axis[0], m.y_axis[0], m.z_axis[0], m.position[0], m.x_axis[1], m.y_axis[1], m.z_axis[1], m.position[1], m.x_axis[2], m.y_axis[2], m.z_axis[2], m.position[2], 0, 0, 0, 1);
            mesh.applyMatrix4(matrix);
            groups.markers.add(mesh);
        });
    }

    // Objects
    if (data.detected_objects) {
        data.detected_objects.forEach(obj => {
            let mesh;
            // Extended Object Types
            if (obj.type === 'toilet') mesh = buildToilet(obj.position);
            else if (obj.type === 'grab_bar') mesh = buildGrabBar(obj.position, obj.length || 0.6, obj.rotation);
            else if (obj.type === 'door') mesh = buildDoor(obj.position, obj.dimensions);
            else if (obj.type === 'sink') mesh = buildSink(obj.position);
            else if (obj.type === 'button') mesh = buildButton(obj.position);
            else if (obj.type === 'garbage') mesh = buildGarbage(obj.position);
            else {
                mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: 0xff9800 }));
                mesh.position.set(...obj.position);
            }

            // Apply rotation for non-grab-bars (grab bars handle it internally due to unique geometry logic)
            if (obj.type !== 'grab_bar' && obj.rotation) {
                mesh.rotation.set(...obj.rotation);
            }

            groups.objects.add(mesh);

            // Height Dimension (only if significantly above floor)
            const floorZ = data.room_box_from_markers_m ? data.room_box_from_markers_m.min[2] : 0;
            const objZ = obj.position[2];
            const height = objZ - floorZ;

            // Show dimensions for items where height matters (button, grab bars, sink)
            if (['button', 'grab_bar', 'sink'].includes(obj.type)) {
                const start = new THREE.Vector3(obj.position[0], obj.position[1], floorZ);
                const end = new THREE.Vector3(obj.position[0], obj.position[1], objZ);
                const dim = createDimension(start, end, `${height.toFixed(2)}m`);
                groups.dimensions.add(dim);
            }
        });
    }

    // Annotations
    if (data.audit_annotations) {
        data.audit_annotations.forEach(note => {
            const pos = new THREE.Vector3(...note.position);
            const labelPos = pos.clone().add(new THREE.Vector3(0, 0, 0.4));
            const lineGeo = new THREE.BufferGeometry().setFromPoints([pos, labelPos]);
            const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.5, transparent: true }));
            groups.annotations.add(line);
            const color = note.status === 'violation' ? 'red' : 'green'; // Red for violations, green for compliant
            const sprite = createTextSprite(note.text, "white", 32, color);
            sprite.position.copy(labelPos);
            groups.annotations.add(sprite);
        });
    }
}

/* --- 5. EXPORT LOGIC --- */

// Export audit data as JSON
document.getElementById('btnExportJSON').addEventListener('click', () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(currentScanData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "audit_scan.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
});

// Export 3D model as GLTF (.glb)
// In the future, save to database so user can revisit past audits with 3D model available 
document.getElementById('btnExportGLTF').addEventListener('click', () => {
    const exporter = new GLTFExporter();
    exporter.parse(
        scene,
        function (gltf) {
            const output = JSON.stringify(gltf, null, 2);
            const blob = new Blob([output], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = url;
            link.download = 'room_model.glb';
            document.body.appendChild(link);
            link.click();
            link.remove();
        },
        function (error) { alert('Export failed'); },
        { binary: true }
    );
});

/* --- 6. APP INITIALIZATION --- */

renderScene(currentScanData);
groups.markers.visible = false;

// UI toggles for layers
document.getElementById('toggleBounds').addEventListener('change', (e) => groups.bounds.visible = e.target.checked);
document.getElementById('toggleObjects').addEventListener('change', (e) => groups.objects.visible = e.target.checked);
document.getElementById('toggleDimensions').addEventListener('change', (e) => groups.dimensions.visible = e.target.checked);
document.getElementById('toggleAnnotations').addEventListener('change', (e) => groups.annotations.visible = e.target.checked);
document.getElementById('toggleMarkers').addEventListener('change', (e) => groups.markers.visible = e.target.checked);

// File upload handler (for user scan data)
document.getElementById('fileInput').addEventListener('change', function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            renderScene(json);
        } catch (err) { alert("Error parsing JSON"); }
    };
    reader.readAsText(file);
});

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});