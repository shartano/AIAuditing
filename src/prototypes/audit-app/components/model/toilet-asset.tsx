import React, { useMemo } from 'react';
import { Box } from '@react-three/drei/native';
import * as THREE from 'three';

// Standard material colour
const porcelainMaterial = new THREE.MeshStandardMaterial({ 
    color: '#FFFFFF', 
    roughness: 0.2, 
    metalness: 0.1 
});

// --- STANDARDS ---
const STANDARD_TOILET_WIDTH = 0.45; 
const STANDARD_TOILET_DEPTH = 0.70; 
const STANDARD_TOILET_HEIGHT = 0.75; // Total height including tank

export const SimpleToilet = ({ object, footprint }: { object: any, footprint: any }) => {
    const { min, max } = object.bbox_aligned;
    const widthX = max[0] - min[0];
    const depthZ = max[2] - min[2];

    const cx = (min[0] + max[0]) / 2;
    const cz = (min[2] + max[2]) / 2;
    
    // FORCE Y TO FLOOR: Ignore the scanned 'cy' and start at 0
    const floorY = 0; 

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
    }, [min, max, footprint, cx, cz]);

    const tankSizeRatio = 0.35; 
    const seatHeightRatio = 0.55; 

    let tankPos = [0, 0, 0];
    let tankArgs = [0, 0, 0];
    let bowlPos = [0, 0, 0];
    let bowlArgs = [0, 0, 0];
    let groupPos: [number, number, number] = [cx, floorY, cz];

    if (directionData.axis === 'x') {
        const isRight = directionData.sign === 1; 
        tankArgs = [STANDARD_TOILET_DEPTH * tankSizeRatio, STANDARD_TOILET_HEIGHT, STANDARD_TOILET_WIDTH];
        bowlArgs = [STANDARD_TOILET_DEPTH * (1 - tankSizeRatio), STANDARD_TOILET_HEIGHT * seatHeightRatio, STANDARD_TOILET_WIDTH];

        const wallLineX = isRight ? max[0] : min[0];
        const anchoredCx = isRight ? wallLineX - (STANDARD_TOILET_DEPTH / 2) : wallLineX + (STANDARD_TOILET_DEPTH / 2);
        
        // Group Y is standard height / 2 because Box positions from center
        groupPos = [anchoredCx, STANDARD_TOILET_HEIGHT / 2, cz];

        const offset = (STANDARD_TOILET_DEPTH / 2) - (tankArgs[0] / 2);
        tankPos = [isRight ? offset : -offset, 0, 0];
        
        const bowlOffset = (STANDARD_TOILET_DEPTH / 2) - (bowlArgs[0] / 2);
        // Position bowl at the bottom of the tank group
        bowlPos = [isRight ? -bowlOffset : bowlOffset, -(STANDARD_TOILET_HEIGHT - bowlArgs[1]) / 2, 0];

    } else {
        const isBack = directionData.sign === 1; 
        tankArgs = [STANDARD_TOILET_WIDTH, STANDARD_TOILET_HEIGHT, STANDARD_TOILET_DEPTH * tankSizeRatio];
        bowlArgs = [STANDARD_TOILET_WIDTH, STANDARD_TOILET_HEIGHT * seatHeightRatio, STANDARD_TOILET_DEPTH * (1 - tankSizeRatio)];

        const wallLineZ = isBack ? max[2] : min[2];
        const anchoredCz = isBack ? wallLineZ - (STANDARD_TOILET_DEPTH / 2) : wallLineZ + (STANDARD_TOILET_DEPTH / 2);
        
        // Group Y is standard height / 2 so the base of the boxes sits at 0
        groupPos = [cx, STANDARD_TOILET_HEIGHT / 2, anchoredCz];

        const offset = (STANDARD_TOILET_DEPTH / 2) - (tankArgs[2] / 2);
        tankPos = [0, 0, isBack ? offset : -offset];

        const bowlOffset = (STANDARD_TOILET_DEPTH / 2) - (bowlArgs[2] / 2);
        bowlPos = [0, -(STANDARD_TOILET_HEIGHT - bowlArgs[1]) / 2, isBack ? -bowlOffset : bowlOffset];
    }

    return (
        <group position={groupPos}>
            {/* TANK */}
            <Box args={tankArgs as [number, number, number]} position={tankPos as [number, number, number]} material={porcelainMaterial} />
            
            {/* BOWL/SEAT */}
            <Box args={bowlArgs as [number, number, number]} position={bowlPos as [number, number, number]} material={porcelainMaterial} />
            
            {/* LID */}
            <Box 
                args={[
                    directionData.axis === 'x' ? bowlArgs[0] : bowlArgs[0] * 0.9, 
                    0.05, 
                    directionData.axis === 'x' ? bowlArgs[2] * 0.9 : bowlArgs[2]
                ]} 
                position={[
                    bowlPos[0], 
                    bowlPos[1] + bowlArgs[1]/2 + 0.025, 
                    bowlPos[2]
                ]} 
            >
                <meshStandardMaterial color="#E0E0E0" />
            </Box>
        </group>
    );
};