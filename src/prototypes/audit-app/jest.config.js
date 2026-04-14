/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterFramework: ['@testing-library/react-native/extend-expect'],
  // jest-expo only transforms the project source by default.
  // This pattern also transforms the Expo/RN packages that ship as ES modules.
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      '(jest-)?react-native' +
      '|@react-native(-community)?' +
      '|expo(nent)?' +
      '|@expo(nent)?/.*' +
      '|@expo-google-fonts/.*' +
      '|react-navigation' +
      '|@react-navigation/.*' +
      '|@unimodules/.*' +
      '|unimodules' +
      '|react-native-svg' +
      '|react-native-reanimated' +
      '|react-native-safe-area-context' +
    '))',
  ],
};
