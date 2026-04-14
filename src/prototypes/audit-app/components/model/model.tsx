import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal } from 'react-native';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import simplify from 'simplify-js';
import { SimpleToilet } from '@/components/model/toilet-asset';
import { SimpleSink } from '@/components/model/sink-asset';
import { SimpleGrabBar } from '@/components/model/grab-bar-asset';

// --- Types ---
type Point2D = [number, number];

type Label = {
    x: number;
    y: number;
    text: string;
    visible: boolean;
    object: ScanData['objects'][0];
};

export interface ScanData {
    footprint: {
        polygon_xz: Point2D[];
        wall_segments_xz: [Point2D, Point2D][];
    };
    objects: {
        id: string;
        type: string;
        bbox_aligned: {
            min: [number, number, number];
            max: [number, number, number];
        };
    }[];
    compliance_report?: {
        test_id: string;
        name: string;
        target_object: string;
        measured_value: any;
        status: string;
        message: string;
    }[];
}

const getRenderType = (type: string) => {
    if (!type) return 'default';
    const t = type.toLowerCase();

    if (t.includes('toilet')) return 'asset';
    if (t.includes('sink') || t.includes('lavatory')) return 'asset';
    if (t.includes('bar') || t.includes('handrail')) return 'asset';

    return 'default';
};

const formatDisplayName = (raw: string) => {
    if (!raw) return '';
    return raw
        .replace(/[_-]+/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase()); // Title Case
};


// --- Helper: Color Coding (of actual generated fixtures in model ) ---
const getFixtureColor = (type: string) => {
    const t = type ? type.toLowerCase() : '';
    if (t.includes('toilet')) return '#3b82f6';
    if (t.includes('sink')) return '#10b981';
    if (t.includes('bar')) return '#f59e0b';
    if (t.includes('door')) return '#8b5cf6';
    if (t.includes('shower')) return '#06b6d4';
    return '#9ca3af'; // Other fixtures
};

// Function to simplify footprint/polygon points using Ramer-Douglas-Peucker algorithm (via simplify-js)
function simplifyFootprint(points: [number, number][], tolerance = 0.15) {
    if (!points || points.length < 3) return points;

    // Convert to simplify-js format
    const pts = points.map(p => ({ x: p[0], y: p[1] }));

    // Run simplification
    const simplified = simplify(pts, tolerance, true);

    // Convert back to [number, number][] format
    return simplified.map(p => [p.x, p.y] as [number, number]);
}

// --- Helper: Generate segments from the simplified polygon
function polygonToSegments(points: [number, number][]) {
    const segments: [[number, number], [number, number]][] = [];

    for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        segments.push([p1, p2]);
    }
    return segments;
}

// --- Helper: Simple noise filtering without reprojection ---
// Just removes short segments and keeps original geometry
function orthogonalizePolygon(points: Point2D[]): Point2D[] {
    if (points.length < 3) return points;

    // Filter short segments to remove noise spikes
    let filtered = filterShortSegments(points, 0.4);

    // If still too many points, filter more aggressively
    if (filtered.length > 8) {
        filtered = filterShortSegments(points, 0.35);
    }

    // Close the polygon if needed
    if (filtered.length >= 3) {
        const first = filtered[0];
        const last = filtered[filtered.length - 1];
        if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.15) {
            filtered = filtered.slice(0, -1);
        }
    }

    return filtered.length >= 3 ? filtered : points;
}

// --- Helper: Filter out tiny noise spikes ---
function filterShortSegments(points: Point2D[], minLength = 0.4): Point2D[] {
    if (points.length < 3) return points;
    const cleaned: Point2D[] = [points[0]];

    for (let i = 1; i < points.length; i++) {
        const prev = cleaned[cleaned.length - 1];
        const curr = points[i];

        // Calculate distance between points
        const dist = Math.sqrt(Math.pow(curr[0] - prev[0], 2) + Math.pow(curr[1] - prev[1], 2));

        // Only keep the point if the segment is long enough
        if (dist > minLength) {
            cleaned.push(curr);
        }
    }
    return cleaned;
}

// --- Sub-Component: Floor & Walls ---
const RoomGeometry = ({ footprint, wallSegments }: { footprint: ScanData['footprint'], wallSegments: [Point2D, Point2D][] }) => {
    // Get simplified polygon from wall segments for floor shape
    const simplifiedPolygon = useMemo(() => {
        if (wallSegments.length === 0) return [];
        const points: Point2D[] = wallSegments.map(seg => seg[0]);
        // Close the loop
        if (wallSegments.length > 0) {
            points.push(wallSegments[wallSegments.length - 1][1]);
        }
        return points;
    }, [wallSegments]);

    const shape = useMemo(() => {
        const shape = new THREE.Shape();

        if (simplifiedPolygon.length > 0) {
            const [startX, startZ] = simplifiedPolygon[0];
            shape.moveTo(startX, startZ);

            for (let i = 1; i < simplifiedPolygon.length; i++) {
                const [x, z] = simplifiedPolygon[i];
                shape.lineTo(x, z);
            }

            shape.closePath();
        }

        return shape;
    }, [simplifiedPolygon]);

    //  Settings for solid floor slab
    const extrudeSettings = useMemo(() => ({
        depth: 0.05, // Thickness of the floor
        bevelEnabled: false,
    }), []);

    // If footprint data is missing, return nothing
    if (!footprint || !footprint.polygon_xz || !wallSegments) {
        return null;
    }

    const WALL_HEIGHT = 2.4;

    return (
        <group>
            {/* Floor Mesh */}
            <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0]} frustumCulled={false} receiveShadow>
                {/* <shapeGeometry args={[shape]} /> */}
                <extrudeGeometry args={[shape, extrudeSettings]} />
                <meshStandardMaterial color="#3e3e3e" side={THREE.DoubleSide} />
            </mesh>

            {/* Walls (Safe Loop) */}
            {wallSegments.map((segment, index) => {
                // SAFETY CHECK: Ensure segment is valid before destructuring
                if (!Array.isArray(segment) || segment.length < 2) return null;

                const [p1, p2] = segment;

                // Double check points exist
                if (!p1 || !p2) return null;

                const width = new THREE.Vector2(p1[0] - p2[0], p1[1] - p2[1]).length();
                const angle = -Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                const midX = (p1[0] + p2[0]) / 2;
                const midZ = (p1[1] + p2[1]) / 2;

                return (
                    <mesh
                        key={`wall-${index}`}
                        position={[midX, WALL_HEIGHT / 2, midZ]}
                        rotation={[0, angle, 0]}
                    >
                        <boxGeometry args={[width, WALL_HEIGHT, 0.06]} />
                        <meshStandardMaterial color="#e7e7e7" transparent opacity={0.35} />
                    </mesh>
                );
            })}
        </group>
    );
};

// --- Sub-Component: Fixtures ---
// Uses RAW wall segments from footprint for accurate wall snapping
const Fixtures = ({
                      objects,
                      footprint,
                      rawWallSegments
                  }: {
    objects: ScanData['objects'];
    footprint: ScanData['footprint'];
    rawWallSegments?: [Point2D, Point2D][];
}) => {
    if (!objects) return null;

    // Use raw wall segments for accurate fixture placement
    const wallSegments = rawWallSegments && rawWallSegments.length > 0
        ? rawWallSegments
        : (footprint?.wall_segments_xz || []);

    return (
        <group>
            {objects.map((obj, i) => {
                if (!obj || !obj.bbox_aligned || !obj.type) return null;

                const { min, max } = obj.bbox_aligned;

                const width = Math.abs(max[0] - min[0]);
                const height = Math.abs(max[1] - min[1]);
                const depth = Math.abs(max[2] - min[2]);
                // Calculate center position of the bounding box
                const pos: [number, number, number] = [
                    (min[0] + max[0]) / 2,
                    (min[1] + max[1]) / 2,
                    (min[2] + max[2]) / 2,
                ];

                // Import simple assets if present, otherwise default to box with color coding
                const type = obj.type.toLowerCase();

                // Pass raw wall segments for accurate wall snapping
                const fixtureFootprint = wallSegments.length > 0
                    ? { ...footprint, wall_segments_xz: wallSegments }
                    : footprint;

                // TOILET
                if (type.includes('toilet')) {
                    return <SimpleToilet key={obj.id} object={obj} footprint={fixtureFootprint} />;
                }

                // SINK
                if (type.includes('sink') || type.includes('lavatory')) {
                    return <SimpleSink key={obj.id} object={obj} footprint={fixtureFootprint} />;
                }

                // GRAB BAR
                if (type.includes('bar') || type.includes('handrail')) {
                    return <SimpleGrabBar key={obj.id} object={obj} footprint={fixtureFootprint} />;
                }

                return (
                    <mesh key={obj.id || i} position={pos}>
                        <boxGeometry args={[width, height, depth]} />
                        <meshStandardMaterial color={getFixtureColor(obj.type)} />
                        <lineSegments>
                            <edgesGeometry args={[new THREE.BoxGeometry(width, height, depth)]} />
                            <lineBasicMaterial color="#a1a1a1" linewidth={2} />
                        </lineSegments>
                    </mesh>
                );
            })}
        </group>
    );
};

// --- Main Component ---
interface RoomViewerProps {
    data: ScanData;
}

export default function RoomViewer({ data }: RoomViewerProps) {
    const [labels, setLabels] = useState<Label[]>([]);
    const [showLabels, setShowLabels] = useState(true);
    const [selectedObject, setSelectedObject] = useState<ScanData['objects'][0] | null>(null);
    const [showModal, setShowModal] = useState(false);

    // If data didn't load, show a placeholder
    if (!data || !data.footprint) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' }}>
                <Text style={{ color: 'white' }}>Loading Room Model...</Text>
            </View>
        );
    }

    const correctionAngle = useMemo(() => {
        const segments = data.footprint.wall_segments_xz;
        if (!segments || segments.length === 0) return 0;

        // Find the longest wall segment to use as the "primary axis"
        let longestDist = 0;
        let mainSegment: [Point2D, Point2D] = segments[0];

        segments.forEach((seg) => {
            const dx = seg[1][0] - seg[0][0];
            const dz = seg[1][1] - seg[0][1];
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > longestDist) {
                longestDist = dist;
                mainSegment = seg;
            }
        });

        // alculate the current angle of that wall
        const dx = mainSegment[1][0] - mainSegment[0][0];
        const dz = mainSegment[1][1] - mainSegment[0][1];
        const wallAngle = Math.atan2(dz, dx);

        // Find the nearest 90-degree snap point (0, 90, 180, 270)
        const snappedAngle = Math.round(wallAngle / (Math.PI / 2)) * (Math.PI / 2);

        // Return the difference to rotate the whole scene back to the grid
        return snappedAngle - wallAngle;
    }, [data]);

    const legendItems = useMemo(() => {
        if (!data?.objects) return [];

        const map = new Map<
            string,
            {
                displayName: string;
                renderType: 'asset' | 'default';
                color?: string;
            }
        >();

        data.objects.forEach((obj) => {
            if (!obj?.type) return;

            const renderType = getRenderType(obj.type);

            if (!map.has(obj.type)) {
                map.set(obj.type, {
                    displayName: formatDisplayName(obj.type),
                    renderType,
                    color:
                        renderType === 'default'
                            ? getFixtureColor(obj.type)
                            : undefined,
                });
            }
        });

        const items = Array.from(map.values());

        // Sort: default first, asset second
        items.sort((a, b) => {
            if (a.renderType === b.renderType) return 0;
            return a.renderType === 'default' ? -1 : 1;
        });

        return items;
    }, [data]);


    const LabelUpdater = ({ objects, setLabels, correctionAngle }: { objects: ScanData['objects'], setLabels: (labels: Label[]) => void, correctionAngle: number }) => {
        const { camera, size } = useThree();
        useFrame(() => {
            const newLabels = objects.map((obj) => {
                if (!obj.bbox_aligned || !obj.type) return null;
                const { min, max } = obj.bbox_aligned;
                let pos = new THREE.Vector3(
                    (min[0] + max[0]) / 2,
                    (min[1] + max[1]) / 2,
                    (min[2] + max[2]) / 2
                );
                // Apply the correction rotation to match the scene rotation
                pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), correctionAngle);
                const screenPos = pos.clone();
                screenPos.project(camera);
                const x = (screenPos.x * 0.5 + 0.5) * size.width;
                const y = (-screenPos.y * 0.5 + 0.5) * size.height;
                return {
                    x,
                    y,
                    text: formatDisplayName(obj.type),
                    visible: screenPos.z > -1 && screenPos.z < 1,
                    object: obj,
                };
            }).filter(Boolean);
            setLabels(newLabels);
        });
        return null;
    };


    // Compute simplified wall segments for ROOM GEOMETRY ONLY
    // Fixtures will use the raw wall segments for accurate snapping
    const processedWallSegments = useMemo(() => {
        if (!data?.footprint?.polygon_xz) return [];

        // Simplify the raw COLMAP data (moderate tolerance)
        const simplified = simplifyFootprint(data.footprint.polygon_xz, 0.2);

        // Filter out short segments (noise) - 0.4m threshold
        const filtered = filterShortSegments(simplified, 0.4);

        // Just remove noise, keep original geometry
        const cleaned = orthogonalizePolygon(filtered);

        // Convert back to segments
        return polygonToSegments(cleaned);
    }, [data]);

    // Raw wall segments for fixtures - use original footprint data
    const rawWallSegments = useMemo(() => {
        return data?.footprint?.wall_segments_xz || [];
    }, [data]);

    return (
        <View
            style={{ flex: 1, backgroundColor: '#3f3f3f' }}>
            <Canvas shadows style={{ flex: 1 }} onCreated={(state) => {
                state.gl.setClearColor('#3f3f3f');
            }}>
                <PerspectiveCamera makeDefault position={[6, 6, 6]} fov={44} />
                <OrbitControls
                    enableZoom={false}
                    enablePan={false}
                    enableDamping={true}
                    rotateSpeed={1.5}
                    touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.ROTATE }}
                />

                <ambientLight intensity={0.5} />
                <directionalLight position={[10, 10, 5]} intensity={1} />
                <pointLight position={[0, 5, 0]} intensity={0.5} />

                <React.Suspense fallback={null}>
                    <group rotation={[0, correctionAngle, 0]}>
                        <RoomGeometry footprint={data.footprint} wallSegments={processedWallSegments} />
                        <Fixtures objects={data.objects} footprint={data.footprint} rawWallSegments={rawWallSegments} />
                    </group>
                </React.Suspense>

                <gridHelper args={[5, 10]} position={[0, 0, 0]} />
                <LabelUpdater objects={data.objects} setLabels={setLabels} correctionAngle={correctionAngle} />
                {/* <axesHelper args={[2]} /> */}
            </Canvas>

            {labels.map((label, i) => (
                label.visible && showLabels && (
                    <TouchableOpacity
                        key={i}
                        style={{
                            position: 'absolute',
                            left: label.x,
                            top: label.y,
                            backgroundColor: 'rgba(0, 0, 0, 0.7)',
                            paddingHorizontal: 4,
                            paddingVertical: 2,
                            borderRadius: 4,
                        }}
                        onPress={() => {
                            setSelectedObject(label.object);
                            setShowModal(true);
                        }}
                    >
                        <Text
                            style={{
                                color: 'white',
                                fontSize: 12,
                                textAlign: 'center',
                            }}
                        >
                            {label.text}
                        </Text>
                    </TouchableOpacity>
                )
            ))}

            <TouchableOpacity
                style={{
                    position: 'absolute', // This keeps the wrapper over the 3D scene
                    top: 60,
                    right: 20, // Padding from the right edge
                    alignItems: 'flex-end', // This pushes the content to the right
                    backgroundColor: 'rgba(0, 0, 0, 0.7)',
                    paddingHorizontal: 10,
                    paddingVertical: 10,
                    borderRadius: 5,
                }}
                onPress={() => setShowLabels(!showLabels)}
            >
                <Text style={{ color: 'white', fontSize: 12 }}>
                    {showLabels ? 'Hide Labels' : 'Show Labels'}
                </Text>
            </TouchableOpacity>

            {legendItems.length > 0 && (
                <View
                    style={{
                        position: 'absolute',
                        bottom: 40,
                        left: 20,
                        backgroundColor: 'rgba(0, 0, 0, 0.54)',
                        padding: 10,
                        borderRadius: 8,
                    }}
                >
                    <Text style={{ color: 'white', fontWeight: 'bold', marginBottom: 5 }}>
                        Fixtures
                    </Text>

                    {legendItems.map((item) => (
                        <View
                            key={item.displayName}
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                marginBottom: 4,
                            }}
                        >
                            {item.renderType === 'default' ? (
                                <View
                                    style={{
                                        width: 12,
                                        height: 12,
                                        backgroundColor: item.color,
                                        marginRight: 8,
                                        borderRadius: 2,
                                    }}
                                />
                            ) : (
                                <Text
                                    style={{
                                        color: 'white',
                                        marginRight: 8,
                                        fontSize: 14,
                                    }}
                                >
                                    •
                                </Text>
                            )}

                            <Text style={{ color: 'white' }}>
                                {item.displayName}
                            </Text>
                        </View>
                    ))}
                </View>
            )}

            <Modal
                visible={showModal}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setShowModal(false)}
            >
                <View
                    style={{
                        flex: 1,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        justifyContent: 'center',
                        alignItems: 'center',
                    }}
                >
                    <View
                        style={{
                            backgroundColor: 'white',
                            padding: 20,
                            borderRadius: 10,
                            width: '80%',
                            maxHeight: '70%',
                        }}
                    >
                        <Text
                            style={{
                                fontSize: 18,
                                fontWeight: 'bold',
                                marginBottom: 10,
                                textAlign: 'center',
                            }}
                        >
                            Compliance Details for {selectedObject ? formatDisplayName(selectedObject.type) : ''}
                        </Text>

                        {selectedObject && data.compliance_report ? (
                            data.compliance_report
                                .filter(check => check.target_object === selectedObject.type)
                                .map((check, index) => (
                                    <View
                                        key={index}
                                        style={{
                                            marginBottom: 10,
                                            padding: 10,
                                            borderRadius: 5,
                                            backgroundColor: check.status === 'green' ? '#d4edda' :
                                                check.status === 'red' ? '#f8d7da' :
                                                check.status === 'yellow' ? '#fff3cd' : '#e2e3e5',
                                        }}
                                    >
                                        <Text style={{ fontWeight: 'bold' }}>{check.name}</Text>
                                        <Text>Measured Value: {check.measured_value !== null ? `${check.measured_value} m` : 'N/A'}</Text>
                                        <Text>Status: {check.message}</Text>
                                    </View>
                                ))
                        ) : (
                            <Text>No compliance data available.</Text>
                        )}

                        <TouchableOpacity
                            style={{
                                backgroundColor: '#007bff',
                                padding: 10,
                                borderRadius: 5,
                                alignItems: 'center',
                                marginTop: 10,
                            }}
                            onPress={() => setShowModal(false)}
                        >
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>Close</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

        </View>
    );
}
