import React, { useMemo } from 'react';
import { Box } from '@react-three/drei/native';
import * as THREE from 'three';

// Materials
const ceramicMaterial = new THREE.MeshStandardMaterial({ 
    color: '#FFFFFF', roughness: 0.2, metalness: 0.1 
});
const chromeMaterial = new THREE.MeshStandardMaterial({ 
    color: '#d3d3d3', roughness: 0.1, metalness: 0.8 
});

export const SimpleSink = ({ object, footprint }: { object: any, footprint: any }) => {
    // Get Dimensions
    const { min, max } = object.bbox_aligned;
    const widthX = max[0] - min[0];
    const heightY = max[1] - min[1];
    const depthZ = max[2] - min[2];
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;

    // Determine orientation
    const directionData = useMemo(() => {
        if (!footprint?.wall_segments_xz) return { axis: 'z', sign: 1 }; 

        const wallSegments = footprint.wall_segments_xz;
        const getDistToWalls = (px: number, pz: number) => {
            let minDist = Infinity;
            wallSegments.forEach((seg: any) => {
                const [p1, p2] = seg;
                const dx = p2[0] - p1[0];
                const dz = p2[1] - p1[1];
                let t = ((px - p1[0]) * dx + (pz - p1[1]) * dz) / (dx * dx + dz * dz);
                t = Math.max(0, Math.min(1, t));
                const dist = Math.sqrt((px - (p1[0] + t * dx))**2 + (pz - (p1[1] + t * dz))**2);
                if (dist < minDist) minDist = dist;
            });
            return minDist;
        };

        const candidates = [
            { id: 'left',  axis: 'x', sign: -1, dist: getDistToWalls(min[0], cz) },
            { id: 'right', axis: 'x', sign:  1, dist: getDistToWalls(max[0], cz) },
            { id: 'front', axis: 'z', sign: -1, dist: getDistToWalls(cx, min[2]) },
            { id: 'back',  axis: 'z', sign:  1, dist: getDistToWalls(cx, max[2]) },
        ];
        candidates.sort((a, b) => a.dist - b.dist);
        return candidates[0];
    }, [min, max, footprint]);

    // Construct Geometry
    // Basin takes up most of the box, Faucet goes on the "wall" side
    const basinHeight = heightY * 0.7;
    const faucetHeight = heightY * 0.3;
    
    let faucetPos = [0, 0, 0];

    // Calculate Faucet Position based on wall direction
    if (directionData.axis === 'x') {
        const isRight = directionData.sign === 1; // Wall is at +X
        // Offset faucet towards the wall (+X or -X)
        const offset = (widthX / 2) - (widthX * 0.15); 
        faucetPos = [isRight ? offset : -offset, (basinHeight/2) + (faucetHeight/2), 0];
    } else {
        const isBack = directionData.sign === 1; // Wall is at +Z
        const offset = (depthZ / 2) - (depthZ * 0.15);
        faucetPos = [0, (basinHeight/2) + (faucetHeight/2), isBack ? offset : -offset];
    }

    return (
        <group position={[cx, cy, cz]}>
            {/* Main Basin Body */}
            <Box args={[widthX, basinHeight, depthZ]} material={ceramicMaterial} />
            
            {/* Inner Basin (Visual Darkening for depth) */}
            <Box 
                args={[widthX * 0.85, basinHeight * 0.05, depthZ * 0.85]} 
                position={[0, basinHeight/2 + 0.001, 0]} 
            >
                <meshStandardMaterial color="#EAEAEA" />
            </Box>

            {/* Faucet (Simple Block) */}
            <Box 
                args={[widthX * 0.2, faucetHeight, depthZ * 0.2]} 
                position={faucetPos as [number, number, number]} 
                material={chromeMaterial} 
            />
        </group>
    );
};