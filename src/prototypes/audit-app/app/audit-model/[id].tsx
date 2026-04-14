import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, Alert, Pressable, Text } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useGlobal } from '@/context/global-provider';
import RoomViewer, { ScanData } from '@/components/model/model';

export default function ModelScreen() {
    const { id } = useLocalSearchParams();
    const { apiUrl, token } = useGlobal();

    const [scanData, setScanData] = useState<ScanData | null>(null);
    const [loading, setLoading] = useState(true);

    const router = useRouter();

    useEffect(() => {
        fetchScan();
    }, [id]);

    const fetchScan = async () => {
        try {
            // Fetch scan JSON data
            const response = await fetch(`${apiUrl}/audits/${id}/result`, {
                headers: { token: token! }
            });

            if (!response.ok) {
                Alert.alert("Error", "Could not load scan data");
                return;
            }

            const json = await response.json();

            setScanData(json);

        } catch (err) {
            console.error(err);
            Alert.alert("Error", "Network error loading model");
        } finally {
            setLoading(false);
        }
    };

    if (loading || !scanData) {
        return (
            <View style={{ flex: 1, justifyContent: 'center' }}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: 'black' }}>
            {loading || !scanData ? (
                <View style={{ flex: 1, justifyContent: 'center' }}>
                    <ActivityIndicator size="large" color="white" />
                </View>
            ) : (
                <>
                    <RoomViewer data={scanData} />

                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: 60,
                            left: 20,
                            backgroundColor: 'rgba(0,0,0,0.54)',
                            borderColor: '#a1a1a1',
                            borderWidth: 1.5,
                            paddingVertical: 12,
                            paddingHorizontal: 18,
                            borderRadius: 8,
                            zIndex: 100, // Vital to stay above the Canvas
                        }}
                    >
                        <Text style={{ color: 'white', fontWeight: '600' }}>Close</Text>
                    </Pressable>
                </>
            )}
        </View>
    );
}
