import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, Keyboard, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { COLORS } from '../constants/theme';
import { useGlobal } from '../context/global-provider';

export default function LoginScreen() {
  const router = useRouter();
  
  // 2. Get Global Values
  const { login, apiUrl } = useGlobal(); 
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
      try {
        // Login to get the Token
        const loginResponse = await axios.post(`${apiUrl}/login`, { email, password });
        const token = loginResponse.data.token;

        if (token) {
          // Use the token to fetch the full user profile immediately
          const userResponse = await axios.get(`${apiUrl}/auth/me`, {
            headers: { token: token }
          });

          // Save Token + Full User Data to Global Context
          await login(token, userResponse.data.user);
          
          router.replace('/(tabs)/home'); 
        }
      } catch (error) {
        console.log("Login Error:", error);
        Alert.alert("Login Failed", "Password or Email incorrect.");
      }
    };

    return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <View style={styles.container}>
        <Text style={styles.logo}>Crepancy</Text>
        <Text style={styles.subtitle}>Accessibility Audit Platform</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={COLORS.textSecondary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          returnKeyType="next"
        />

        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={COLORS.textSecondary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="done"
        />

        <TouchableOpacity style={styles.button} onPress={handleLogin}>
          <Text style={styles.buttonText}>LOGIN</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/register')}>
          <Text style={styles.linkText}>Create account</Text>
        </TouchableOpacity>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    padding: 30, 
    justifyContent: 'center', 
    backgroundColor: COLORS.background
  },
  logo: { 
    fontSize: 40, 
    fontWeight: '900', 
    color: COLORS.primary,
    textAlign: 'center' 
  },
  subtitle: { 
    fontSize: 14, 
    color: COLORS.textSecondary,
    textAlign: 'center', 
    marginBottom: 40 
  },
  input: { 
    height: 55, 
    borderWidth: 1, 
    borderColor: COLORS.border,
    borderRadius: 12, 
    paddingHorizontal: 15, 
    marginBottom: 15, 
    backgroundColor: COLORS.card,
    color: COLORS.textPrimary
  },
  button: { 
    backgroundColor: COLORS.primary,
    height: 55, 
    borderRadius: 12, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginTop: 10 
  },
  buttonText: { 
    color: '#fff', 
    fontSize: 16, 
    fontWeight: 'bold' 
  },
  linkText: { 
    color: COLORS.primary,
    textAlign: 'center', 
    marginTop: 20, 
    fontWeight: '600' 
  }
});