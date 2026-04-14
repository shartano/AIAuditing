import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Dimensions,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gyroscope, Magnetometer } from 'expo-sensors';
import Svg, { Circle } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useGlobal } from '../context/global-provider';

const { width } = Dimensions.get('window');
const RADIUS = 45;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type CaptureStep = 'SETUP' | 'DISTANCE' | 'RECORDING' | 'COMPLETE';

export default function Camera() {
  const { apiUrl: API_URL } = useGlobal();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();

  const [isRecording, setIsRecording] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [captureStep, setCaptureStep] = useState<CaptureStep>('SETUP');
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const lastAngleRef = useRef<number | null>(null);
  const accumulatedRotationRef = useRef(0);
  const cameraRef = useRef<CameraView>(null);
  const insets = useSafeAreaInsets();

  const scanIdRef = useRef<string | null>(null);
  const uploadStartedRef = useRef(false);
  const stopRequestedRef = useRef(false);

  const { videoUri } = useLocalSearchParams<{ videoUri?: string }>();
  const ranUploadRef = useRef(false);

  const showResultPopup = (success: boolean, message?: string) => {
    Alert.alert(
      success ? 'Successfully received' : 'Upload failed',
      success
        ? 'We received your scan and started processing it.'
        : message ?? 'Could not upload/process this scan. Please try again.',
      [
        {
          text: 'OK',
          onPress: () => {
            if (success){
              router.replace('/(tabs)/history');
            };
          },
        },
      ]
    );
  };

  /* ---------------------------- sensors ---------------------------- */

  useEffect(() => {
    Gyroscope.setUpdateInterval(100);
    Magnetometer.setUpdateInterval(100);

    const gyroSub = Gyroscope.addListener(({ x, y, z }) => {
      const speed = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
      setShowWarning(isRecording && speed > 0.8);
    });

    const magSub = Magnetometer.addListener(({ x, y }) => {
      let currentAngle = Math.atan2(y, x) * (180 / Math.PI);
      if (currentAngle < 0) currentAngle += 360;

      if (isRecording && captureStep === 'RECORDING') {
        if (lastAngleRef.current !== null) {
          let delta = currentAngle - lastAngleRef.current;

          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;

          accumulatedRotationRef.current += Math.abs(delta);

          const totalRotationNeeded = 720;
          const completion = Math.min(accumulatedRotationRef.current / totalRotationNeeded, 1);

          setProgress(completion);

          if (completion >= 1) {
            if (!stopRequestedRef.current) {
              handleStopRecording();
            }
          }
        }
        lastAngleRef.current = currentAngle;
      }
    });

    return () => {
      gyroSub.remove();
      magSub.remove();
    };
  }, [isRecording, captureStep]);

  /* ---------------------- frame funcs  ---------------------- */

  const extractFramesFromVideo = async (videoUri: string, desiredFrames: number) => {
    const frames: { uri: string; name: string; type: string }[] = [];

    const maxMs = 55_000;
    const step = Math.max(1, Math.floor(maxMs / desiredFrames));

    for (let i = 0; i < desiredFrames; i++) {
      const time = i * step;
      try {
        const thumb = await VideoThumbnails.getThumbnailAsync(videoUri, {
          time,
          quality: 0.7,
        });
        if (thumb?.uri) {
          const frameNumber = String(frames.length).padStart(3, '0');
          frames.push({
            uri: thumb.uri,
            name: `frame_${frameNumber}.jpg`,
            type: 'image/jpeg',
          });
        }
      } catch {
        // Ignore thumbnail failures
      }
    }
    return frames;
  };

  const uploadFrameBatch = async (frames: { uri: string; name: string; type: string }[]) => {
    if (uploadStartedRef.current) return false;
    uploadStartedRef.current = true;

    try {
      const token = await AsyncStorage.getItem('token');
      if (!token) throw new Error('Missing auth token');

      const scanId = scanIdRef.current || `scan_${Date.now()}`;
      scanIdRef.current = scanId;

      if (!frames.length) {
        console.warn('No frames generated; skipping upload.');
        throw new Error('No frames generated from the video.');
      }

      const fd = new FormData();
      for (let i = 0; i < frames.length; i++) {
        fd.append('frames', frames[i] as any);
      }

      fd.append(
        'metadata',
        JSON.stringify({
          scanId,
          frameCount: frames.length,
          capturedAtMs: Date.now(),
          pipeline: { colmap: true, yolo: true },
          source: 'video_thumbnails',
        })
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      const res = await fetch(`${API_URL}/scan/batch`, {
        method: 'POST',
        headers: { token },
        body: fd,
        signal: controller.signal as any,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed: ${res.status} ${text}`);
      }

      return true;
    } catch (err) {
      console.error('uploadFrameBatch error:', err);
      return false;
    }
  };

  /* -------------------- shared pipeline -------------------- */

  const resetForNewScan = () => {
    accumulatedRotationRef.current = 0;
    lastAngleRef.current = null;
    setProgress(0);

    scanIdRef.current = `scan_${Date.now()}`;
    uploadStartedRef.current = false;
    stopRequestedRef.current = false;
  };

  const processVideoAndFinish = async (uri: string, frameCount: number) => {
    try {
      setIsProcessing(true);
      setCaptureStep('RECORDING'); // keeps UI consistent with your current states

      const frames = await extractFramesFromVideo(uri, frameCount);
      const okUpload = await uploadFrameBatch(frames);

      if (okUpload) {
        setCaptureStep('COMPLETE');
        showResultPopup(true);
      } else {
        setCaptureStep('COMPLETE');
        showResultPopup(false, 'Could not upload video. Please try again.');
      }
    } catch (e) {
      console.error('processVideoAndFinish error:', e);
      setCaptureStep('COMPLETE');
      showResultPopup(false, 'Could not upload video. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  /* ---------------------------- record flow ---------------------------- */

  const handleRecordStart = async () => {
    if (!cameraRef.current) return;

    resetForNewScan();

    setIsRecording(true);
    setCaptureStep('RECORDING');

    try {
      const recording = await cameraRef.current.recordAsync({ maxDuration: 60 });
      const uri = recording?.uri;
      if (uri) {
        // After recording stops, we process it
        await processVideoAndFinish(uri, 100);
      } else {
        showResultPopup(false, 'Recording did not produce a video file.');
      }
    } catch (error) {
      console.error(error);
      showResultPopup(false, 'Recording failed.');
    } finally {
      setIsRecording(false);
      setCaptureStep('COMPLETE');
    }
  };

  const handleStopRecording = () => {
    if (cameraRef.current && isRecording) {
      stopRequestedRef.current = true;
      try {
        cameraRef.current.stopRecording();
      } catch (e) {
        console.error('stopRecording failed:', e);
      }
    }
  };

  /* -------------------------- upload flow (videoUri) -------------------------- */

  useEffect(() => {
    if (!videoUri) return;
    if (ranUploadRef.current) return;
    ranUploadRef.current = true;

    (async () => {
      resetForNewScan();
      await processVideoAndFinish(videoUri, 100);
    })();
  }, [videoUri]);

  /* --------------------------- ui helpers --------------------------- */

  const getDynamicPrompt = () => {
    if (captureStep === 'SETUP') return 'Center Aruco marker on floor.';
    if (captureStep === 'DISTANCE') return 'Stand 1-2m from walls. Point at fixtures.';
    if (progress < 0.5) return 'Loop 1: Walk perimeter at eye-level.';
    if (progress < 0.75) return 'Loop 2: Lift camera higher (High Loop).';
    return 'Final Pass: Lower camera to waist-level (Low Loop).';
  };

  const strokeDashoffset = CIRCUMFERENCE * (1 - progress);

  /* -------------------------- permissions -------------------------- */

  if (!permission?.granted && !videoUri) {
    return (
      <View style={styles.center}>
        <TouchableOpacity onPress={requestPermission}>
          <Text style={{ color: '#fff' }}>Enable Camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  /* ------------------ NEW: hide camera preview while processing/uploaded ------------------ */

  if (videoUri || isProcessing) {
    return (
      <>
        <Stack.Screen options={{ title: 'Uploading', headerBackTitle: 'Home' }} />
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" />
          <Text style={styles.processingTitle}>Processing your scan…</Text>
          <Text style={styles.processingSubtitle}>
            Extracting frames and uploading. Please keep the app open.
          </Text>
        </View>
      </>
    );
  }

  /* ------------------------------- main UI ------------------------------- */

  return (
    <>
      <Stack.Screen options={{ title: 'Camera', headerBackTitle: 'Home' }} />

      <View style={styles.container}>
        <CameraView
          style={StyleSheet.absoluteFill}
          ref={cameraRef}
          mode="video"
          videoQuality="2160p"
        >
          <View style={[styles.overlay, { paddingTop: insets.top + 20 }]}>
            <View style={styles.rulesBadge}>
              <Text style={styles.rulesText}>WALK PERIMETER • NO SPINNING • NO SUDDEN TURNS</Text>
            </View>

            <View style={styles.instructionCard}>
              <Text style={styles.stepTitle}>AUDIT DATA ACQUISITION</Text>
              <Text style={styles.stepPrompt}>{getDynamicPrompt()}</Text>
            </View>

            {showWarning && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>⚠️ STEADY CAMERA</Text>
                <Text style={styles.warningSubtext}>High speed ruins 3D geometry</Text>
              </View>
            )}

            <View style={styles.centerContainer}>
              {captureStep === 'RECORDING' && (
                <View style={styles.progressWrapper}>
                  <Svg width="140" height="140" viewBox="0 0 120 120">
                    <Circle
                      cx="60"
                      cy="60"
                      r={RADIUS}
                      stroke="rgba(255,255,255,0.2)"
                      strokeWidth="6"
                      fill="none"
                    />
                    <Circle
                      cx="60"
                      cy="60"
                      r={RADIUS}
                      stroke="#4C66EE"
                      strokeWidth="6"
                      fill="none"
                      strokeDasharray={CIRCUMFERENCE}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                      transform="rotate(-90 60 60)"
                    />
                  </Svg>

                  <Text style={styles.progressPercent}>{Math.round(progress * 100)}%</Text>
                </View>
              )}

              {captureStep === 'SETUP' && <View style={styles.markerTarget} />}
            </View>

            <View style={[styles.controls, { paddingBottom: insets.bottom + 40 }]}>
              {captureStep === 'SETUP' || captureStep === 'DISTANCE' ? (
                <TouchableOpacity
                  onPress={() =>
                    setCaptureStep(captureStep === 'SETUP' ? 'DISTANCE' : 'RECORDING')
                  }
                  style={styles.nextButton}
                >
                  <Text style={styles.nextButtonText}>
                    {captureStep === 'SETUP' ? 'MARKER ALIGNED' : 'START PERIMETER SCAN'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    onPress={isRecording ? handleStopRecording : handleRecordStart}
                    style={styles.recordButton}
                  >
                    <View style={[styles.innerButton, isRecording && styles.recordingButton]} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </CameraView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  overlay: { flex: 1, justifyContent: 'space-between', alignItems: 'center' },
  rulesBadge: {
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginBottom: 10,
  },
  rulesText: { color: 'rgba(255,255,255,0.7)', fontSize: 9, fontWeight: 'bold', letterSpacing: 0.5 },
  instructionCard: {
    width: '92%',
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  stepTitle: { fontSize: 10, fontWeight: '900', color: '#4C66EE', letterSpacing: 1.5, textAlign: 'center' },
  stepPrompt: { fontSize: 17, fontWeight: '700', color: '#1A1A1A', textAlign: 'center', marginTop: 8 },

  warningContainer: {
    position: 'absolute',
    top: 180,
    backgroundColor: '#FF3B30',
    padding: 15,
    borderRadius: 12,
    width: '80%',
    alignItems: 'center',
  },
  warningText: { color: '#fff', fontWeight: '900', fontSize: 20 },
  warningSubtext: { color: '#fff', fontSize: 13 },

  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  progressWrapper: { justifyContent: 'center', alignItems: 'center' },
  progressPercent: { position: 'absolute', color: '#fff', fontSize: 24, fontWeight: 'bold' },

  markerTarget: { width: 140, height: 140, borderWidth: 2, borderColor: '#34C759', borderStyle: 'dashed' },

  controls: { width: '100%', alignItems: 'center' },
  nextButton: { backgroundColor: '#4C66EE', paddingHorizontal: 40, paddingVertical: 20, borderRadius: 35 },
  nextButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },

  recordButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 6,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  innerButton: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  recordingButton: { backgroundColor: '#FF3B30', borderRadius: 10, width: 38, height: 38 },
  actionRow: { width: '100%', alignItems: 'center', justifyContent: 'center' },

  // processing screen styles
  processingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  processingTitle: { marginTop: 16, fontSize: 18, fontWeight: '800', color: '#fff' },
  processingSubtitle: { marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center' },
});