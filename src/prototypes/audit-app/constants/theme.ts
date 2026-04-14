import { Platform } from 'react-native';

// 1.  Accessible Palette (Dark Blue Theme)
const palette = {
  navy: '#001F3F', // Primary Brand / Headings
  blueGrey: '#546E7A', // Secondary Text
  brightBlue: '#335C85', // Interactive Links/Buttons
  white: '#FFFFFF',
  offWhite: '#F2F2F7', // Backgrounds
  darkGreen: '#006400', // Success Text
  lightGreen: '#E8F5E9', // Success Bg
  darkOrange: '#8A5300', // Warning Text
  lightOrange: '#FFF3E0', // Warning Bg
  red: '#D32F2F', // Error
  grayBorder: '#B0BEC5',
};

// 2. Export the flat color object
export const COLORS = {
  // Core UI
  background: palette.offWhite,
  card: palette.white,
  border: palette.grayBorder,
  
  // Text (High Contrast)
  textPrimary: palette.navy,
  textSecondary: palette.blueGrey,
  
  // Branding
  primary: palette.navy,
  accent: palette.brightBlue,
  
  // Status Indicators
  success: palette.darkGreen,
  successBg: palette.lightGreen,
  warning: palette.darkOrange,
  warningBg: palette.lightOrange,
  error: palette.red,
  
  // Icons
  iconActive: palette.navy,
  iconInactive: palette.blueGrey,
};

// 3. Export "Colors" for Expo Router (Tabs/Navigation) compatibility
export const Colors = {
  light: {
    text: palette.navy,
    background: palette.offWhite,
    tint: palette.navy, // Active Tab Color
    icon: palette.blueGrey,
    tabIconDefault: palette.blueGrey,
    tabIconSelected: palette.navy,
  },
};

// 4. Fonts
export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});