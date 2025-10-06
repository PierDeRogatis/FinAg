// Import Firebase per la gestione del database
import { db } from './firebase-config.js';
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

// Attende che il DOM sia completamente caricato
document.addEventListener('DOMContentLoaded', () => {
    // Registra il componente Alpine prima dell'inizializzazione
    window.Alpine.data('aiFinderForm', () => ({
        // Stato del form: 'idle', 'searching', 'submitted'
        state: 'idle',
        
        // Gestione submit del form AI Finder
        async handleSubmit(event) {
            // Cambia stato a 'searching' durante il processo
            this.state = 'searching';
            
            // Estrae i dati dal form
            const formData = new FormData(event.target);
            
            // Costruisce l'oggetto strutturato per Firestore
            const structuredData = {
                requestData: {
                    email: formData.get('email'),
                    settore: formData.get('settore'),
                    dimensioni: formData.get('dimensioni'),
                    dipendenti: formData.get('dipendenti'),
                    area: formData.get('area')
                },
                status: 'pending',
                analysisResult: null,
                createdAt: new Date()
            };

            try {
                // Salva il documento nella collection 'grant_requests'
                await addDoc(collection(db, "grant_requests"), structuredData);
                
                // Simula tempo di elaborazione per UX
                setTimeout(() => {
                    this.state = 'submitted';
                }, 2000);
            } catch (error) {
                console.error("Errore durante il salvataggio:", error);
                alert("Si è verificato un errore durante l'invio. Riprova.");
                this.state = 'idle';
            }
        }
    }));

    // Inizializzazione Swiper per il carousel Case Study
    const swiper = new Swiper('.case-study-slider', {
        loop: true,
        slidesPerView: 1,
        spaceBetween: 30,
        pagination: {
            el: '.swiper-pagination',
            clickable: true
        },
        breakpoints: {
            768: {
                slidesPerView: 2,
                spaceBetween: 30
            },
            1024: {
                slidesPerView: 3,
                spaceBetween: 30
            }
        },
        autoplay: {
            delay: 5000,
            disableOnInteraction: false
        }
    });
});

// Effetto glow del cursore
const cursorGlow = document.getElementById('cursor-glow');
if (cursorGlow) {
    document.addEventListener('mousemove', (e) => {
        window.requestAnimationFrame(() => {
            cursorGlow.style.left = `${e.clientX}px`;
            cursorGlow.style.top = `${e.clientY}px`;
        });
    });
}