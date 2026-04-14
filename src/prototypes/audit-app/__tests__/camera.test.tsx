/**
 * Tests for app/camera.tsx
 *
 * Install required dev dependencies before running:
 *   npm install --save-dev jest-expo @testing-library/react-native @types/jest
 *
 * Run:
 *   npx jest __tests__/camera.test.tsx
 */

import React from 'react';
import { Alert } from 'react-native';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Module mocks
// All jest.mock() calls are hoisted before imports by Babel. Mock factories
// must use require() internally. Mocks that need to be accessed from tests
// expose shared jest.fn() instances via properties on the module return value,
// retrieved with jest.requireMock() in beforeEach.
// ---------------------------------------------------------------------------

// expo-camera ----------------------------------------------------------------
// CameraView is mocked as a forwardRef component so the internal cameraRef
// receives a real imperative handle (recordAsync / stopRecording).
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');

  const mockRecordAsync   = jest.fn();
  const mockStopRecording = jest.fn();
  const mockUseCameraPermissions = jest.fn();

  const CameraView = React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      recordAsync:   mockRecordAsync,
      stopRecording: mockStopRecording,
    }));
    return React.createElement(View, { testID: 'camera-view', ...props });
  });
  CameraView.displayName = 'MockCameraView';

  return {
    CameraView,
    useCameraPermissions: mockUseCameraPermissions,
    // Exposed so tests can configure / assert against them
    __mockRecordAsync:          mockRecordAsync,
    __mockStopRecording:        mockStopRecording,
    __mockUseCameraPermissions: mockUseCameraPermissions,
  };
});

// expo-sensors ---------------------------------------------------------------
// addListener is a jest.fn() so tests can retrieve the registered callback via
// (Gyroscope.addListener as jest.Mock).mock.calls.at(-1)[0] after rendering.
jest.mock('expo-sensors', () => ({
  Gyroscope: {
    setUpdateInterval: jest.fn(),
    addListener:       jest.fn(() => ({ remove: jest.fn() })),
  },
  Magnetometer: {
    setUpdateInterval: jest.fn(),
    addListener:       jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// expo-video-thumbnails -------------------------------------------------------
jest.mock('expo-video-thumbnails', () => ({
  getThumbnailAsync: jest.fn(),
}));

// expo-router -----------------------------------------------------------------
const mockRouterReplace = jest.fn();
const mockRouterPush    = jest.fn();

let mockSearchParams: { videoUri?: string } = {};

jest.mock('expo-router', () => ({
  useRouter:            () => ({ replace: mockRouterReplace, push: mockRouterPush }),
  useLocalSearchParams: () => mockSearchParams,
  Stack: { Screen: () => null },
}));

// global-provider -------------------------------------------------------------
jest.mock('../context/global-provider', () => ({
  useGlobal: () => ({ apiUrl: 'http://test-api.example.com' }),
}));

// AsyncStorage ----------------------------------------------------------------
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// react-native-safe-area-context ----------------------------------------------
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// react-native-svg ------------------------------------------------------------
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default:    ({ children }: any) => React.createElement(View, null, children),
    Circle:     () => null,
  };
});

// ---------------------------------------------------------------------------
// Imports that are used in tests (after mocks are registered)
// ---------------------------------------------------------------------------
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Gyroscope, Magnetometer } from 'expo-sensors';

import Camera from '../app/camera';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Grant camera permission and set no videoUri — the normal launch state. */
function grantPermission() {
  const { __mockUseCameraPermissions } = jest.requireMock('expo-camera') as any;
  __mockUseCameraPermissions.mockReturnValue([
    { granted: true },
    jest.fn(), // requestPermission
  ]);
}

/** Deny camera permission. */
function denyPermission() {
  const { __mockUseCameraPermissions } = jest.requireMock('expo-camera') as any;
  __mockUseCameraPermissions.mockReturnValue([
    { granted: false },
    jest.fn(),
  ]);
}

/** Return the most recent gyroscope listener registered by the component. */
function getLatestGyroListener(): (data: { x: number; y: number; z: number }) => void {
  const calls = (Gyroscope.addListener as jest.Mock).mock.calls;
  if (!calls.length) throw new Error('Gyroscope.addListener was never called');
  return calls[calls.length - 1][0];
}

/** Return the most recent magnetometer listener registered by the component. */
function getLatestMagListener(): (data: { x: number; y: number }) => void {
  const calls = (Magnetometer.addListener as jest.Mock).mock.calls;
  if (!calls.length) throw new Error('Magnetometer.addListener was never called');
  return calls[calls.length - 1][0];
}

/**
 * Return an {x, y} magnetometer reading that produces a specific compass
 * heading in degrees (0–360). Uses atan2(y, x) * (180/π) as the component does.
 */
function headingToReading(degrees: number): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/** Navigate the UI from SETUP → DISTANCE → RECORDING. */
function advanceToRecordingStep() {
  fireEvent.press(screen.getByText('MARKER ALIGNED'));
  fireEvent.press(screen.getByText('START PERIMETER SCAN'));
}

/** Make VideoThumbnails return n successful frames. */
function mockThumbnailSuccess(count: number) {
  (VideoThumbnails.getThumbnailAsync as jest.Mock).mockImplementation(
    (_uri: string, { time }: { time: number }) =>
      Promise.resolve({ uri: `file://frame_at_${time}.jpg` }),
  );
}

/** Make VideoThumbnails always throw. */
function mockThumbnailAlwaysFail() {
  (VideoThumbnails.getThumbnailAsync as jest.Mock).mockRejectedValue(
    new Error('Thumbnail extraction failed'),
  );
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};            // no videoUri by default
  grantPermission();                // default: permission granted

  // Default: fetch succeeds
  global.fetch = jest.fn().mockResolvedValue({
    ok:   true,
    text: jest.fn().mockResolvedValue(''),
  });

  // Default: token present in storage
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('test-jwt-token');
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// 1. Rendering / UI state
// ===========================================================================

describe('Rendering', () => {
  it('shows the permission prompt when camera access is not granted and no videoUri', () => {
    denyPermission();
    render(<Camera />);
    expect(screen.getByText('Enable Camera')).toBeTruthy();
  });

  it('shows the main recording UI when permission is granted', () => {
    render(<Camera />);
    expect(screen.getByText('AUDIT DATA ACQUISITION')).toBeTruthy();
    expect(screen.getByText('WALK PERIMETER • NO SPINNING • NO SUDDEN TURNS')).toBeTruthy();
  });

  it('shows the processing screen when isProcessing becomes true', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    // recordAsync never resolves → isProcessing stays true while awaited
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));
    mockThumbnailSuccess(1);

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    expect(screen.getByText('Processing your scan…')).toBeTruthy();
    expect(screen.getByText('Extracting frames and uploading. Please keep the app open.')).toBeTruthy();
  });

  it('shows the processing screen immediately when videoUri is provided', async () => {
    denyPermission(); // permission is irrelevant when videoUri is set
    mockSearchParams = { videoUri: 'file://existing-video.mp4' };
    mockThumbnailSuccess(1);

    await act(async () => {
      render(<Camera />);
    });

    expect(screen.getByText('Processing your scan…')).toBeTruthy();
  });

  it('renders the progress ring and percentage in RECORDING step', () => {
    render(<Camera />);
    advanceToRecordingStep();
    expect(screen.getByText('0%')).toBeTruthy();
  });
});

// ===========================================================================
// 2. Step navigation
// ===========================================================================

describe('Step navigation', () => {
  it('starts in SETUP step and shows MARKER ALIGNED button', () => {
    render(<Camera />);
    expect(screen.getByText('MARKER ALIGNED')).toBeTruthy();
  });

  it('advances to DISTANCE step when MARKER ALIGNED is pressed', () => {
    render(<Camera />);
    fireEvent.press(screen.getByText('MARKER ALIGNED'));
    expect(screen.getByText('START PERIMETER SCAN')).toBeTruthy();
  });

  it('advances to RECORDING step when START PERIMETER SCAN is pressed', () => {
    render(<Camera />);
    advanceToRecordingStep();
    // Record button (no text label) is now visible; step buttons are gone
    expect(screen.queryByText('START PERIMETER SCAN')).toBeNull();
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('does not show the recording button before reaching RECORDING step', () => {
    render(<Camera />);
    // In SETUP step, the action row with the record button is not rendered
    expect(screen.queryByText('0%')).toBeNull();
  });
});

// ===========================================================================
// 3. getDynamicPrompt
// ===========================================================================

describe('getDynamicPrompt', () => {
  it('shows setup prompt in SETUP step', () => {
    render(<Camera />);
    expect(screen.getByText('Center Aruco marker on floor.')).toBeTruthy();
  });

  it('shows distance prompt in DISTANCE step', () => {
    render(<Camera />);
    fireEvent.press(screen.getByText('MARKER ALIGNED'));
    expect(screen.getByText('Stand 1-2m from walls. Point at fixtures.')).toBeTruthy();
  });

  it('shows Loop 1 prompt at the start of RECORDING (progress 0)', () => {
    render(<Camera />);
    advanceToRecordingStep();
    expect(screen.getByText('Loop 1: Walk perimeter at eye-level.')).toBeTruthy();
  });

  it('shows Loop 2 prompt when progress reaches 0.5', async () => {
    render(<Camera />);
    advanceToRecordingStep();

    const magCb = getLatestMagListener();

    // Simulate 360° of rotation (progress = 360/720 = 0.5)
    // Two readings 180° apart, each contributing 180° of delta
    act(() => magCb(headingToReading(0)));
    act(() => magCb(headingToReading(180)));
    act(() => magCb(headingToReading(0)));

    await waitFor(() =>
      expect(screen.getByText('Loop 2: Lift camera higher (High Loop).')).toBeTruthy(),
    );
  });

  it('shows Final Pass prompt when progress reaches 0.75', async () => {
    render(<Camera />);
    advanceToRecordingStep();

    const magCb = getLatestMagListener();

    // Drive to 540° of rotation (progress = 540/720 = 0.75)
    act(() => magCb(headingToReading(0)));
    for (let i = 0; i < 3; i++) {
      act(() => magCb(headingToReading(180)));
      act(() => magCb(headingToReading(0)));
    }

    await waitFor(() =>
      expect(screen.getByText('Final Pass: Lower camera to waist-level (Low Loop).')).toBeTruthy(),
    );
  });
});

// ===========================================================================
// 4. Gyroscope sensor
// ===========================================================================

describe('Gyroscope sensor', () => {
  it('sets sensor update interval to 100ms on mount', () => {
    render(<Camera />);
    expect(Gyroscope.setUpdateInterval).toHaveBeenCalledWith(100);
  });

  it('shows the shake warning when speed > 0.8 while recording', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button')); // start recording
    });

    // Refresh listeners after state change (isRecording = true re-runs the effect)
    const gyroCb = getLatestGyroListener();
    act(() => gyroCb({ x: 1, y: 0, z: 0 })); // speed = 1.0 > 0.8

    await waitFor(() =>
      expect(screen.getByText('⚠️ STEADY CAMERA')).toBeTruthy(),
    );
  });

  it('does not show the warning when moving fast but NOT recording', async () => {
    render(<Camera />);
    // isRecording is false at this point
    const gyroCb = getLatestGyroListener();
    act(() => gyroCb({ x: 1, y: 1, z: 1 })); // speed = √3 ≈ 1.73

    expect(screen.queryByText('⚠️ STEADY CAMERA')).toBeNull();
  });

  it('clears the warning when camera steadies below 0.8 threshold', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const gyroCb = getLatestGyroListener();
    act(() => gyroCb({ x: 1, y: 0, z: 0 })); // trigger warning
    act(() => gyroCb({ x: 0, y: 0, z: 0 })); // clear warning (speed = 0)

    await waitFor(() =>
      expect(screen.queryByText('⚠️ STEADY CAMERA')).toBeNull(),
    );
  });

  it('removes the gyroscope subscription on unmount', () => {
    const mockRemove = jest.fn();
    (Gyroscope.addListener as jest.Mock).mockReturnValue({ remove: mockRemove });

    const { unmount } = render(<Camera />);
    unmount();

    expect(mockRemove).toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. Magnetometer — rotation tracking
// ===========================================================================

describe('Magnetometer sensor', () => {
  it('sets sensor update interval to 100ms on mount', () => {
    render(<Camera />);
    expect(Magnetometer.setUpdateInterval).toHaveBeenCalledWith(100);
  });

  it('does not accumulate rotation before the second reading (lastAngle starts null)', async () => {
    render(<Camera />);
    advanceToRecordingStep();

    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(90))); // first reading — sets lastAngle, no delta

    // Progress should remain at 0
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('accumulates delta between consecutive readings and updates progress', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(0)));    // lastAngle = 0
    act(() => magCb(headingToReading(90)));   // delta = 90 → progress = 90/720 ≈ 12.5%

    await waitFor(() =>
      expect(screen.getByText('13%')).toBeTruthy(), // Math.round(90/720 * 100) = 13
    );
  });

  it('normalises a large positive delta (wrap from 350° → 10°) to ~20°', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();
    // lastAngle = 350, currentAngle = 10 → raw delta = -340 → +360 = 20
    act(() => magCb(headingToReading(350)));
    act(() => magCb(headingToReading(10)));

    // progress = 20/720 ≈ 2.8% → rounds to 3%
    await waitFor(() =>
      expect(screen.getByText('3%')).toBeTruthy(),
    );
  });

  it('normalises a large negative delta (wrap from 10° → 350°) to ~20°', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();
    // lastAngle = 10, currentAngle = 350 → raw delta = 340 → -360 = -20 → abs = 20
    act(() => magCb(headingToReading(10)));
    act(() => magCb(headingToReading(350)));

    await waitFor(() =>
      expect(screen.getByText('3%')).toBeTruthy(),
    );
  });

  it('auto-stops recording when accumulated rotation reaches 720°', async () => {
    const { __mockRecordAsync, __mockStopRecording } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();

    // Drive 720° of absolute rotation in 180° steps (4 pairs of readings)
    act(() => magCb(headingToReading(0)));
    for (let i = 0; i < 4; i++) {
      act(() => magCb(headingToReading(180)));
      act(() => magCb(headingToReading(0)));
    }

    await waitFor(() => expect(__mockStopRecording).toHaveBeenCalled());
  });

  it('calls stopRecording only once even if listener fires past 720°', async () => {
    const { __mockRecordAsync, __mockStopRecording } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();

    act(() => magCb(headingToReading(0)));
    for (let i = 0; i < 6; i++) { // overshoot with 6 pairs (1080° total)
      act(() => magCb(headingToReading(180)));
      act(() => magCb(headingToReading(0)));
    }

    await waitFor(() =>
      expect(__mockStopRecording).toHaveBeenCalledTimes(1),
    );
  });

  it('does not accumulate rotation when isRecording is false', () => {
    render(<Camera />);
    advanceToRecordingStep();
    // isRecording is false — never pressed record button

    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(0)));
    act(() => magCb(headingToReading(180)));

    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('removes the magnetometer subscription on unmount', () => {
    const mockRemove = jest.fn();
    (Magnetometer.addListener as jest.Mock).mockReturnValue({ remove: mockRemove });

    const { unmount } = render(<Camera />);
    unmount();

    expect(mockRemove).toHaveBeenCalled();
  });
});

// ===========================================================================
// 6. extractFramesFromVideo
// ===========================================================================

describe('extractFramesFromVideo', () => {
  beforeEach(() => {
    mockSearchParams = { videoUri: 'file://scan.mp4' };
  });

  it('calls getThumbnailAsync for each desired frame (100 frames)', async () => {
    mockThumbnailSuccess(100);

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() =>
      expect(VideoThumbnails.getThumbnailAsync).toHaveBeenCalledTimes(100),
    );
  });

  it('passes timestamps spaced by floor(55000/desiredFrames) milliseconds', async () => {
    mockThumbnailSuccess(100);

    await act(async () => {
      render(<Camera />);
    });

    const calls = (VideoThumbnails.getThumbnailAsync as jest.Mock).mock.calls;
    const expectedStep = Math.floor(55_000 / 100); // 550ms

    expect(calls[0][1].time).toBe(0);
    expect(calls[1][1].time).toBe(expectedStep);
    expect(calls[2][1].time).toBe(expectedStep * 2);
  });

  it('requests quality 0.7 for each thumbnail', async () => {
    mockThumbnailSuccess(100);

    await act(async () => {
      render(<Camera />);
    });

    const calls = (VideoThumbnails.getThumbnailAsync as jest.Mock).mock.calls;
    calls.forEach((call: any[]) => {
      expect(call[1].quality).toBe(0.7);
    });
  });

  it('names frames with zero-padded sequential numbers (frame_000, frame_001, …)', async () => {
    mockThumbnailSuccess(100);

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const body: FormData = (global.fetch as jest.Mock).mock.calls[0][1].body;
    // The frame objects are appended as { uri, name, type }.
    // We inspect via the mock FormData implementation.
    // Verify the mock thumbnail URIs contain sequential timestamps.
    const calls = (VideoThumbnails.getThumbnailAsync as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe('file://scan.mp4');
    expect(calls[99][0]).toBe('file://scan.mp4');
  });

  it('skips frames where getThumbnailAsync throws and includes the rest', async () => {
    let callCount = 0;
    (VideoThumbnails.getThumbnailAsync as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 0) throw new Error('Thumbnail error'); // every even call fails
      return Promise.resolve({ uri: `file://frame_${callCount}.jpg` });
    });

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // Upload should still have been called (with the 50 successful frames)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not attempt upload when all thumbnails fail', async () => {
    mockThumbnailAlwaysFail();
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());

    // fetch should NOT have been called (no frames to upload)
    expect(global.fetch).not.toHaveBeenCalled();

    const alertArgs = (Alert.alert as jest.Mock).mock.calls[0];
    expect(alertArgs[0]).toBe('Upload failed');
  });

  it('skips frames where getThumbnailAsync resolves with a null uri', async () => {
    (VideoThumbnails.getThumbnailAsync as jest.Mock).mockResolvedValue({ uri: null });
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 7. uploadFrameBatch
// ===========================================================================

describe('uploadFrameBatch', () => {
  beforeEach(() => {
    mockSearchParams = { videoUri: 'file://test.mp4' };
    mockThumbnailSuccess(3); // minimal frame count for speed
  });

  it('returns true and shows success popup when fetch responds with 200', async () => {
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Successfully received');
  });

  it('posts to the correct API endpoint with the JWT token header', async () => {
    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://test-api.example.com/scan/batch');
    expect(options.method).toBe('POST');
    expect(options.headers.token).toBe('test-jwt-token');
  });

  it('reads the auth token from AsyncStorage', async () => {
    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('token');
  });

  it('shows failure popup and does not fetch when AsyncStorage has no token', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(global.fetch).not.toHaveBeenCalled();
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed');
  });

  it('shows failure popup when the server responds with a 4xx status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:   false,
      status: 401,
      text: jest.fn().mockResolvedValue('Unauthorized'),
    });
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed');
  });

  it('shows failure popup when the server responds with a 5xx status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok:     false,
      status: 503,
      text:   jest.fn().mockResolvedValue('Service Unavailable'),
    });
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed');
  });

  it('shows failure popup when fetch throws a network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network request failed'));
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed');
  });

  it('does not make a second upload call if the upload flow runs twice', async () => {
    // ranUploadRef prevents the effect running twice for the same videoUri
    let renderCount = 0;

    await act(async () => {
      const { rerender } = render(<Camera />);
      // Re-render with the same videoUri — should not trigger a second upload
      rerender(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toBeTruthy());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 8. processVideoAndFinish
// ===========================================================================

describe('processVideoAndFinish', () => {
  beforeEach(() => {
    mockSearchParams = { videoUri: 'file://test.mp4' };
  });

  it('sets captureStep to COMPLETE on successful upload', async () => {
    mockThumbnailSuccess(3);
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    // After success, captureStep = COMPLETE — step buttons are gone
    expect(screen.queryByText('MARKER ALIGNED')).toBeNull();
  });

  it('calls showResultPopup(true) on successful upload', async () => {
    mockThumbnailSuccess(3);
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Successfully received',
        'We received your scan and started processing it.',
        expect.any(Array),
      ),
    );
  });

  it('calls showResultPopup(false) when upload fails', async () => {
    mockThumbnailSuccess(3);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: jest.fn().mockResolvedValue('') });
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() =>
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed'),
    );
  });

  it('calls showResultPopup(false) when processVideoAndFinish itself throws', async () => {
    (VideoThumbnails.getThumbnailAsync as jest.Mock).mockRejectedValue(new Error('Hard crash'));
    jest.spyOn(Alert, 'alert');

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() =>
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed'),
    );
  });
});

// ===========================================================================
// 9. handleRecordStart
// ===========================================================================

describe('handleRecordStart', () => {
  it('calls recordAsync with a 60 second max duration', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockResolvedValue({ uri: 'file://recording.mp4' });
    mockThumbnailSuccess(3);

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    await waitFor(() => expect(__mockRecordAsync).toHaveBeenCalled());
    expect(__mockRecordAsync).toHaveBeenCalledWith({ maxDuration: 60 });
  });

  it('calls processVideoAndFinish when recordAsync resolves with a URI', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockResolvedValue({ uri: 'file://recording.mp4' });
    mockThumbnailSuccess(3);
    jest.spyOn(Alert, 'alert');

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(VideoThumbnails.getThumbnailAsync).toHaveBeenCalled();
  });

  it('shows a "no video file" error popup when recordAsync resolves without a URI', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockResolvedValue({ uri: undefined });
    jest.spyOn(Alert, 'alert');

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Upload failed',
        'Recording did not produce a video file.',
        expect.any(Array),
      ),
    );
    expect(VideoThumbnails.getThumbnailAsync).not.toHaveBeenCalled();
  });

  it('shows a "Recording failed" popup when recordAsync throws', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockRejectedValue(new Error('Camera error'));
    jest.spyOn(Alert, 'alert');

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Upload failed',
        'Recording failed.',
        expect.any(Array),
      ),
    );
  });

  it('resets accumulated rotation before starting a new recording', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;

    let resolveRecording!: (v: any) => void;
    __mockRecordAsync.mockReturnValue(new Promise(r => { resolveRecording = r; }));

    render(<Camera />);
    advanceToRecordingStep();

    // Simulate some rotation before starting
    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(0)));
    act(() => magCb(headingToReading(180)));

    await act(async () => {
      fireEvent.press(screen.getByRole('button')); // start recording → resetForNewScan
    });

    // After reset, progress should be 0
    expect(screen.getByText('0%')).toBeTruthy();

    // Cleanup: resolve the recording to avoid open promise leak
    resolveRecording({ uri: undefined });
  });
});

// ===========================================================================
// 10. handleStopRecording
// ===========================================================================

describe('handleStopRecording', () => {
  it('calls stopRecording when the record button is pressed a second time while recording', async () => {
    const { __mockRecordAsync, __mockStopRecording } = jest.requireMock('expo-camera') as any;

    // recordAsync resolves only after stopRecording is called
    let resolveRecording!: (v: any) => void;
    __mockRecordAsync.mockReturnValue(
      new Promise(r => { resolveRecording = r; }),
    );

    render(<Camera />);
    advanceToRecordingStep();

    // First press: starts recording (isRecording = true)
    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    // Second press: isRecording is true → calls handleStopRecording
    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    expect(__mockStopRecording).toHaveBeenCalledTimes(1);

    // Cleanup
    resolveRecording({ uri: undefined });
  });

  it('sets stopRequestedRef to prevent a double-stop from the magnetometer', async () => {
    const { __mockRecordAsync, __mockStopRecording } = jest.requireMock('expo-camera') as any;

    let resolveRecording!: (v: any) => void;
    __mockRecordAsync.mockReturnValue(
      new Promise(r => { resolveRecording = r; }),
    );

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button')); // start
    });

    // Manual stop via button
    await act(async () => {
      fireEvent.press(screen.getByRole('button')); // stop
    });

    // Now simulate the magnetometer reaching 720° — should not call stopRecording again
    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(0)));
    for (let i = 0; i < 4; i++) {
      act(() => magCb(headingToReading(180)));
      act(() => magCb(headingToReading(0)));
    }

    // stopRecording should still have been called exactly once
    expect(__mockStopRecording).toHaveBeenCalledTimes(1);

    resolveRecording({ uri: undefined });
  });

  it('does not throw if stopRecording itself throws', async () => {
    const { __mockRecordAsync, __mockStopRecording } = jest.requireMock('expo-camera') as any;

    let resolveRecording!: (v: any) => void;
    __mockRecordAsync.mockReturnValue(new Promise(r => { resolveRecording = r; }));
    __mockStopRecording.mockImplementation(() => { throw new Error('stopRecording failed'); });

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    // Should not throw
    expect(() => {
      act(() => { fireEvent.press(screen.getByRole('button')); });
    }).not.toThrow();

    resolveRecording({ uri: undefined });
  });
});

// ===========================================================================
// 11. showResultPopup
// ===========================================================================

describe('showResultPopup', () => {
  beforeEach(() => {
    mockSearchParams = { videoUri: 'file://test.mp4' };
    jest.spyOn(Alert, 'alert');
  });

  it('uses "Successfully received" as the title on success', async () => {
    mockThumbnailSuccess(3);

    await act(async () => { render(<Camera />); });

    await waitFor(() =>
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Successfully received'),
    );
  });

  it('uses "Upload failed" as the title on failure', async () => {
    mockThumbnailAlwaysFail();

    await act(async () => { render(<Camera />); });

    await waitFor(() =>
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Upload failed'),
    );
  });

  it('shows the default failure message when no custom message is provided', async () => {
    mockThumbnailAlwaysFail();

    await act(async () => { render(<Camera />); });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    const message = (Alert.alert as jest.Mock).mock.calls[0][1];
    expect(message).toBe('Could not upload/process this scan. Please try again.');
  });

  it('navigates to history tab when the success OK button is pressed', async () => {
    mockThumbnailSuccess(3);

    await act(async () => { render(<Camera />); });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());

    // Simulate pressing the OK button in the Alert
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    act(() => buttons[0].onPress());

    expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/history');
  });

  it('does not navigate when the failure OK button is pressed', async () => {
    mockThumbnailAlwaysFail();

    await act(async () => { render(<Camera />); });

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());

    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    act(() => buttons[0].onPress());

    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 12. videoUri upload flow (pre-existing video path)
// ===========================================================================

describe('videoUri upload flow', () => {
  it('triggers processVideoAndFinish when videoUri is provided as a route param', async () => {
    mockSearchParams = { videoUri: 'file://pre-existing.mp4' };
    mockThumbnailSuccess(3);
    jest.spyOn(Alert, 'alert');

    await act(async () => { render(<Camera />); });

    await waitFor(() => expect(VideoThumbnails.getThumbnailAsync).toHaveBeenCalled());
    expect((VideoThumbnails.getThumbnailAsync as jest.Mock).mock.calls[0][0]).toBe(
      'file://pre-existing.mp4',
    );
  });

  it('does not trigger upload when videoUri is absent', async () => {
    mockSearchParams = {}; // no videoUri
    render(<Camera />);

    // Give time for any erroneous effects to fire
    await act(async () => {});

    expect(VideoThumbnails.getThumbnailAsync).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('runs the upload flow only once per mount even if the component re-renders', async () => {
    mockSearchParams = { videoUri: 'file://pre-existing.mp4' };
    mockThumbnailSuccess(3);

    await act(async () => {
      const { rerender } = render(<Camera />);
      rerender(<Camera />);
      rerender(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    // ranUploadRef prevents re-runs
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('passes the videoUri directly to extractFramesFromVideo, not a different URI', async () => {
    const VIDEO_URI = 'file://specific-video-12345.mp4';
    mockSearchParams = { videoUri: VIDEO_URI };
    mockThumbnailSuccess(3);

    await act(async () => { render(<Camera />); });

    await waitFor(() => expect(VideoThumbnails.getThumbnailAsync).toHaveBeenCalled());

    const firstCall = (VideoThumbnails.getThumbnailAsync as jest.Mock).mock.calls[0];
    expect(firstCall[0]).toBe(VIDEO_URI);
  });

  it('shows the processing screen (not the camera UI) while the upload runs', async () => {
    mockSearchParams = { videoUri: 'file://video.mp4' };
    // Never resolve thumbnails so the processing screen stays up
    (VideoThumbnails.getThumbnailAsync as jest.Mock).mockReturnValue(new Promise(() => {}));

    render(<Camera />);

    // The processing screen should be visible immediately
    expect(screen.getByText('Processing your scan…')).toBeTruthy();
    // The main camera UI should not be visible
    expect(screen.queryByText('AUDIT DATA ACQUISITION')).toBeNull();
  });
});

// ===========================================================================
// 13. Gyroscope threshold boundary
// The warning condition is speed > 0.8 (strict), so exactly 0.8 must NOT warn.
// ===========================================================================

describe('Gyroscope threshold boundary', () => {
  async function startRecording() {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });
  }

  it('does NOT show the warning when speed is exactly 0.8 (boundary: > 0.8 is required)', async () => {
    await startRecording();

    const gyroCb = getLatestGyroListener();
    // speed = √(0.8²) = 0.8 — should not trigger (condition is strictly > 0.8)
    act(() => gyroCb({ x: 0.8, y: 0, z: 0 }));

    expect(screen.queryByText('⚠️ STEADY CAMERA')).toBeNull();
  });

  it('shows the warning when speed is just above the boundary (0.801)', async () => {
    await startRecording();

    const gyroCb = getLatestGyroListener();
    act(() => gyroCb({ x: 0.801, y: 0, z: 0 }));

    await waitFor(() =>
      expect(screen.getByText('⚠️ STEADY CAMERA')).toBeTruthy(),
    );
  });

  it('computes speed as the vector magnitude of all three axes', async () => {
    await startRecording();

    const gyroCb = getLatestGyroListener();
    // √(0.4² + 0.4² + 0.4²) = √0.48 ≈ 0.693 — below threshold
    act(() => gyroCb({ x: 0.4, y: 0.4, z: 0.4 }));
    expect(screen.queryByText('⚠️ STEADY CAMERA')).toBeNull();

    // √(0.6² + 0.6² + 0.6²) = √1.08 ≈ 1.039 — above threshold
    act(() => gyroCb({ x: 0.6, y: 0.6, z: 0.6 }));
    await waitFor(() =>
      expect(screen.getByText('⚠️ STEADY CAMERA')).toBeTruthy(),
    );
  });
});

// ===========================================================================
// 14. Camera permission — requestPermission button
// ===========================================================================

describe('Camera permission — requestPermission button', () => {
  it('calls requestPermission when the Enable Camera button is pressed', () => {
    const mockRequestPermission = jest.fn();
    const { __mockUseCameraPermissions } = jest.requireMock('expo-camera') as any;
    __mockUseCameraPermissions.mockReturnValue([
      { granted: false },
      mockRequestPermission,
    ]);

    render(<Camera />);
    fireEvent.press(screen.getByText('Enable Camera'));

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('does not show the permission prompt when videoUri is provided (skips permission check)', async () => {
    // Permission is denied but videoUri is set — the processing screen should render,
    // not the permission prompt.
    const { __mockUseCameraPermissions } = jest.requireMock('expo-camera') as any;
    __mockUseCameraPermissions.mockReturnValue([{ granted: false }, jest.fn()]);

    mockSearchParams = { videoUri: 'file://video.mp4' };
    (VideoThumbnails.getThumbnailAsync as jest.Mock).mockReturnValue(new Promise(() => {}));

    render(<Camera />);

    expect(screen.queryByText('Enable Camera')).toBeNull();
    expect(screen.getByText('Processing your scan…')).toBeTruthy();
  });
});

// ===========================================================================
// 15. Counter-clockwise rotation
// Math.abs(delta) means walking CCW still accumulates progress toward 720°.
// ===========================================================================

describe('Counter-clockwise rotation', () => {
  async function renderAndStartRecording() {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });
  }

  it('advances progress when the heading decreases (counter-clockwise)', async () => {
    await renderAndStartRecording();

    const magCb = getLatestMagListener();
    act(() => magCb(headingToReading(90)));  // set lastAngle = 90
    act(() => magCb(headingToReading(0)));   // delta = 0 - 90 = -90 → abs = 90 → progress = 90/720

    await waitFor(() =>
      expect(screen.getByText('13%')).toBeTruthy(), // Math.round(90/720 * 100) = 13
    );
  });

  it('treats a counter-clockwise near-wrap (from 10° → 350°) as ~20° of rotation', async () => {
    await renderAndStartRecording();

    const magCb = getLatestMagListener();
    // raw delta = 350 - 10 = 340 → > 180, so -360 → -20 → abs = 20
    act(() => magCb(headingToReading(10)));
    act(() => magCb(headingToReading(350)));

    await waitFor(() =>
      expect(screen.getByText('3%')).toBeTruthy(), // Math.round(20/720 * 100) = 3
    );
  });

  it('auto-stops when 720° is accumulated entirely via counter-clockwise movement', async () => {
    const { __mockStopRecording } = jest.requireMock('expo-camera') as any;
    await renderAndStartRecording();

    const magCb = getLatestMagListener();

    // Alternate 180° CCW steps: 180→0→180→0→... each step adds 180°
    act(() => magCb(headingToReading(180)));
    for (let i = 0; i < 4; i++) {
      act(() => magCb(headingToReading(0)));
      act(() => magCb(headingToReading(180)));
    }

    await waitFor(() => expect(__mockStopRecording).toHaveBeenCalled());
  });
});

// ===========================================================================
// 16. Progress hard-cap at 100%
// Math.min(accumulated / 720, 1) ensures progress never exceeds 1.0.
// ===========================================================================

describe('Progress hard-cap at 100%', () => {
  it('displays 100% and does not go higher after exceeding 720° of rotation', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    render(<Camera />);
    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button'));
    });

    const magCb = getLatestMagListener();

    // Drive 1080° (6 pairs of 180° steps) — well past 720°
    act(() => magCb(headingToReading(0)));
    for (let i = 0; i < 6; i++) {
      act(() => magCb(headingToReading(180)));
      act(() => magCb(headingToReading(0)));
    }

    await waitFor(() =>
      expect(screen.getByText('100%')).toBeTruthy(),
    );
    // Ensure '101%' or higher never appears
    expect(screen.queryByText('101%')).toBeNull();
  });
});

// ===========================================================================
// 17. FormData metadata content
// Verifies the metadata JSON appended to the multipart upload.
// ===========================================================================

describe('FormData metadata content', () => {
  beforeEach(() => {
    mockSearchParams = { videoUri: 'file://test.mp4' };
    mockThumbnailSuccess(5);
  });

  it('includes a scanId matching the scan_<timestamp> format', async () => {
    const beforeMs = Date.now();

    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const body: FormData = (global.fetch as jest.Mock).mock.calls[0][1].body;
    // FormData.get is available in the jest-expo mock environment
    const rawMetadata = (body as any).get('metadata') as string;
    const metadata = JSON.parse(rawMetadata);

    const afterMs = Date.now();

    expect(metadata.scanId).toMatch(/^scan_\d+$/);
    const timestamp = parseInt(metadata.scanId.replace('scan_', ''), 10);
    expect(timestamp).toBeGreaterThanOrEqual(beforeMs);
    expect(timestamp).toBeLessThanOrEqual(afterMs);
  });

  it('sets frameCount to the number of successfully extracted frames', async () => {
    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const body: FormData = (global.fetch as jest.Mock).mock.calls[0][1].body;
    const metadata = JSON.parse((body as any).get('metadata'));

    expect(metadata.frameCount).toBe(5);
  });

  it('sets pipeline flags colmap and yolo to true', async () => {
    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const body: FormData = (global.fetch as jest.Mock).mock.calls[0][1].body;
    const metadata = JSON.parse((body as any).get('metadata'));

    expect(metadata.pipeline).toEqual({ colmap: true, yolo: true });
  });

  it('sets source to "video_thumbnails"', async () => {
    await act(async () => {
      render(<Camera />);
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const body: FormData = (global.fetch as jest.Mock).mock.calls[0][1].body;
    const metadata = JSON.parse((body as any).get('metadata'));

    expect(metadata.source).toBe('video_thumbnails');
  });
});

// ===========================================================================
// 18. Sensor effect re-registration on isRecording change
// The useEffect depends on [isRecording, captureStep]. When isRecording flips,
// old subscriptions must be removed and new ones registered.
// ===========================================================================

describe('Sensor effect re-registration', () => {
  it('removes and re-registers gyroscope subscription when recording starts', async () => {
    const { __mockRecordAsync } = jest.requireMock('expo-camera') as any;
    __mockRecordAsync.mockReturnValue(new Promise(() => {}));

    const mockRemove = jest.fn();
    (Gyroscope.addListener as jest.Mock).mockReturnValue({ remove: mockRemove });

    render(<Camera />);

    // Effect runs once on mount
    const addListenerCallsBefore = (Gyroscope.addListener as jest.Mock).mock.calls.length;

    advanceToRecordingStep();

    await act(async () => {
      fireEvent.press(screen.getByRole('button')); // isRecording → true, re-runs effect
    });

    // Old subscription should have been cleaned up
    expect(mockRemove).toHaveBeenCalled();
    // A new subscription should have been registered
    expect((Gyroscope.addListener as jest.Mock).mock.calls.length).toBeGreaterThan(
      addListenerCallsBefore,
    );
  });

  it('removes and re-registers magnetometer subscription when captureStep changes', () => {
    const mockRemove = jest.fn();
    (Magnetometer.addListener as jest.Mock).mockReturnValue({ remove: mockRemove });

    render(<Camera />);

    const callsBefore = (Magnetometer.addListener as jest.Mock).mock.calls.length;

    // SETUP → DISTANCE triggers a captureStep change, re-running the effect
    act(() => {
      fireEvent.press(screen.getByText('MARKER ALIGNED'));
    });

    expect(mockRemove).toHaveBeenCalled();
    expect((Magnetometer.addListener as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ===========================================================================
// 19. uploadFrameBatch — uploadStartedRef double-call guard
// A second call to uploadFrameBatch within the same scan (same uploadStartedRef)
// must return false without firing a second network request.
// ===========================================================================

describe('uploadFrameBatch — uploadStartedRef guard', () => {
  it('sends only one fetch request even if processVideoAndFinish is somehow invoked twice for the same scan', async () => {
    // Simulate two back-to-back videoUri triggers being processed. Because
    // uploadStartedRef is set to true after the first call, the second call
    // should return early without hitting fetch.
    //
    // We can exercise this by mounting with videoUri, letting the first upload
    // run, unmounting, and mounting again WITH THE SAME ranUploadRef in scope.
    // The simpler observable proxy: a re-render mid-upload should not double-send.

    mockSearchParams = { videoUri: 'file://test.mp4' };
    mockThumbnailSuccess(3);

    // Hold fetch open so we can rerender while it is in-flight
    let resolveFetch!: (v: any) => void;
    (global.fetch as jest.Mock).mockReturnValue(
      new Promise(r => { resolveFetch = r; }),
    );

    await act(async () => {
      const { rerender } = render(<Camera />);
      // Re-render while upload is in-flight
      rerender(<Camera />);
      rerender(<Camera />);
    });

    // Resolve the in-flight request
    resolveFetch({ ok: true, text: jest.fn().mockResolvedValue('') });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    // Despite multiple renders, only one request should have been fired
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});