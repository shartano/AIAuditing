import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// --- 1. CONFIGURATION ---
export const API_URL = "https://crepancy-production.up.railway.app"

// --- 2. TYPES ---
interface User {
  id?: string; 
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  [key: string]: any; 
}

// Define the shape of the Context
interface GlobalContextType {
  // Data
  apiUrl: string;
  user: User | null;
  token: string | null;
  isLoading: boolean;
  loading: boolean;
  
  // Actions
  login: (token: string, userData: User) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (newData: Partial<User>) => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
}

// Create Context
const GlobalContext = createContext<GlobalContextType | undefined>(undefined);

// --- 3. PROVIDER COMPONENT ---
export function GlobalProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load data from storage when the app starts
  useEffect(() => {
    const loadStorageData = async () => {
      try {
        const storedUser = await AsyncStorage.getItem('user');
        const storedToken = await AsyncStorage.getItem('token');

        if (storedUser && storedToken) {
          setUser(JSON.parse(storedUser));
          setToken(storedToken);
        }
      } catch (error) {
        console.error('Failed to load user data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadStorageData();
  }, []);

  // Login: Updates State + Saves to Storage
  const login = async (newToken: string, newUser: User) => {
    setToken(newToken);
    setUser(newUser);
    try {
      await AsyncStorage.setItem('token', newToken);
      await AsyncStorage.setItem('user', JSON.stringify(newUser));
    } catch (e) {
      console.error("Failed to save login data", e);
    }
  };

  // Logout: Clears State + Removes from Storage
  const logout = async () => {
    setToken(null);
    setUser(null);
    try {
      await AsyncStorage.removeItem('token');
      await AsyncStorage.removeItem('user');
    } catch (e) {
      console.error("Failed to clear logout data", e);
    }
  };

  // Update User: Merges new data with existing user data
  const updateUser = async (newData: Partial<User>) => {
    if (!user) return; // Can't update if not logged in

    const updatedUser = { ...user, ...newData }; // Merge old + new
    setUser(updatedUser); // Update State
    try {
      await AsyncStorage.setItem('user', JSON.stringify(updatedUser)); // Update Storage
    } catch (e) {
      console.error("Failed to update user storage", e);
    }
  };

  return (
    <GlobalContext.Provider 
      value={{
        apiUrl: API_URL,
        user,
        setUser,
        token,
        isLoading,
        loading: isLoading, // FIX: Maps 'isLoading' state to 'loading' interface
        login,
        logout,
        updateUser
      }}
    >
      {children}
    </GlobalContext.Provider>
  );
}

// --- 4. CUSTOM HOOK ---
export function useGlobal() {
  const context = useContext(GlobalContext);
  if (!context) {
    throw new Error('useGlobal must be used within a GlobalProvider');
  }
  return context;
}