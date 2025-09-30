// Importa le funzioni necessarie dalla CDN di Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// La tua configurazione Firebase
const firebaseConfig = {
    apiKey: "AIzaSyB0rMdKiFmahRHMbF864xVhci9njYxm8-w",
    authDomain: "finage-efd7b.firebaseapp.com",
    projectId: "finage-efd7b",
    storageBucket: "finage-efd7b.appspot.com",
    messagingSenderId: "204371538639",
    appId: "1:204371538639:web:31287fcd00319b637bbdba",
    measurementId: "G-16R66G0BHV"
};

// Inizializza Firebase
const app = initializeApp(firebaseConfig);

// Esporta l'istanza di Firestore per usarla altrove
export const db = getFirestore(app);