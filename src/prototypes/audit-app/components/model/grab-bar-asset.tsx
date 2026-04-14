import React, { useMemo } from 'react';
import { Box } from '@react-three/drei/native';
import * as THREE from 'three';

const metalMaterial = new THREE.MeshStandardMaterial({ 
    color: '#d3d3d3', roughness: 0.3, metalness: 0.6 
});

export const SimpleGrabBar = ({ object, footprint }: { object: any, footprint: any }) => {
    const { min, max } = object.bbox_aligned;
    const widthX = max[0] - min[0];
    const heightY = max[1] - min[1];
    const depthZ = max[2] - min[2];
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;

    // Detect if it's a vertical grab bar (Tall and thin)
    const isVertical = heightY > widthX && heightY > depthZ;

    // Determine Wall Direction
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

    // Geometry Construction
    const barThickness = Math.min(widthX, depthZ, heightY) * 0.6; 
    let mainBarArgs = [0, 0, 0];
    let mountArgs = [0, 0, 0];
    let mountOffset = 0; // Distance to push mounts towards the wall

    if (isVertical) {
        // Vertical Bar (along Y)
        mainBarArgs = [barThickness, heightY, barThickness];
        
        // Mounts connect from center to wall
        if (directionData.axis === 'x') {
            mountArgs = [widthX/2, barThickness, barThickness]; // Connect X
            mountOffset = (widthX/4) * directionData.sign;
        } else {
            mountArgs = [barThickness, barThickness, depthZ/2]; // Connect Z
            mountOffset = (depthZ/4) * directionData.sign;
        }
    } else {
        // Horizontal Bar
        if (directionData.axis === 'x') {
            // Wall is X, Bar runs along Z
            mainBarArgs = [barThickness, barThickness, depthZ]; 
            mountArgs = [widthX/2, barThickness, barThickness];
            mountOffset = (widthX/4) * directionData.sign;
        } else {
            // Wall is Z, Bar runs along X
            mainBarArgs = [widthX, barThickness, barThickness];
            mountArgs = [barThickness, barThickness, depthZ/2];
            mountOffset = (depthZ/4) * directionData.sign;
        }
    }

    const mountPositions = isVertical 
        ? [ // Top and Bottom mounts
            directionData.axis === 'x' ? [mountOffset, heightY/2 - 0.05, 0] : [0, heightY/2 - 0.05, mountOffset],
            directionData.axis === 'x' ? [mountOffset, -heightY/2 + 0.05, 0] : [0, -heightY/2 + 0.05, mountOffset]
        ]
        : [ // Left and Right mounts
            directionData.axis === 'x' ? [mountOffset, 0, depthZ/2 - 0.05] : [widthX/2 - 0.05, 0, mountOffset],
            directionData.axis === 'x' ? [mountOffset, 0, -depthZ/2 + 0.05] : [-widthX/2 + 0.05, 0, mountOffset]
        ];

    return (
        <group position={[cx, cy, cz]}>
            {/* Main Handle Bar */}
            <Box args={mainBarArgs as [number, number, number]} material={metalMaterial} />
            
            {/* Wall Mounts */}
            <Box args={mountArgs as [number, number, number]} position={mountPositions[0] as [number, number, number]} material={metalMaterial} />
            <Box args={mountArgs as [number, number, number]} position={mountPositions[1] as [number, number, number]} material={metalMaterial} />
        </group>
    );
};