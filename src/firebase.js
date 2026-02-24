import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// ──────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Replace these values with your own Firebase project config.
// Go to https://console.firebase.google.com → your project → Project Settings
// → General → Your apps → Firebase SDK snippet → Config
// ──────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAcE8crSK03gqSN0RVCpZXJRrlNdGVWloY",
  authDomain: "cashflowapp-bfacb.firebaseapp.com",
  projectId: "cashflowapp-bfacb",
  storageBucket: "cashflowapp-bfacb.firebasestorage.app",
  messagingSenderId: "343464097560",
  appId: "1:343464097560:web:28bb6f9bc9538a10b3d06d",
  measurementId: "G-04S2LR0X9P"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
