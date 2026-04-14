import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, Keyboard, TouchableWithoutFeedback, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { COLORS } from '../constants/theme';
import { useGlobal } from '../context/global-provider';

export default function RegisterScreen() {
  const router = useRouter();
  
  // 2. Get Global Values
  const { login, apiUrl } = useGlobal(); 
  
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleRegister = async () => {
    try {
      const response = await axios.post(`${apiUrl}/register`, {
        email,
        password,
        first_name: firstName,
        last_name: lastName,
        role: 'general'
      });

      if (response.data.token) {
        await login(response.data.token, response.data.user);
        router.replace('/'); 
      }
    } catch (error) {
      console.log(error);
      Alert.alert("Registration Error", "User already exists or connection failed.");
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <View style={styles.container}>
        <Text style={styles.header}>Create Account</Text>

        <TextInput
          style={styles.input}
          placeholder="First Name"
          placeholderTextColor={COLORS.textSecondary}
          value={firstName}
          onChangeText={setFirstName}
          returnKeyType="next"
        />

        <TextInput
          style={styles.input}
          placeholder="Last Name"
          placeholderTextColor={COLORS.textSecondary}
          value={lastName}
          onChangeText={setLastName}
          returnKeyType="next"
        />

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={COLORS.textSecondary}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
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

        <TouchableOpacity style={styles.button} onPress={handleRegister}>
          <Text style={styles.buttonText}>REGISTER</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/')}>
          <Text style={styles.linkText}>Already have an account? Login</Text>
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
    backgroundColor: COLORS.background // Global Background
  },
  header: { 
    fontSize: 28, 
    fontWeight: 'bold', 
    color: COLORS.textPrimary, // Navy Blue
    marginBottom: 30 
  },
  input: { 
    height: 55, 
    borderWidth: 1, 
    borderColor: COLORS.border, // Global Border
    borderRadius: 12, 
    paddingHorizontal: 15, 
    marginBottom: 15, 
    backgroundColor: COLORS.card, // White card bg
    color: COLORS.textPrimary
  },
  button: { 
    backgroundColor: COLORS.primary, // Navy Blue
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
    color: COLORS.primary, // Navy Blue Link
    textAlign: 'center', 
    marginTop: 20, 
    fontWeight: '600' 
  }
});