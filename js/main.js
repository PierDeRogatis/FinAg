import { db } from './firebase-config.js';
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

document.addEventListener('alpine:init', () => {
    // Componente Alpine per il form AI Finder
    Alpine.data('aiFinderForm', () => ({
        state: 'idle', // Valori possibili: 'idle', 'searching', 'submitted'
        async handleSubmit(event) {
            this.state = 'searching';
            const formData = new FormData(event.target);
            const data = {
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
                // Aggiunge un nuovo documento alla collection 'grant_requests'
                await addDoc(collection(db, "grant_requests"), data);
                // Simula un'attesa per l'effetto di ricerca
                setTimeout(() => {
                    this.state = 'submitted';
                }, 2000);
            } catch (e) {
                console.error("Errore nell'aggiungere il documento: ", e);
                alert("Si è verificato un errore durante l'invio. Riprova.");
                this.state = 'idle'; // Resetta lo stato in caso di errore
            }
        }
    }));

    // Inizializza lo Swiper per le Storie di Successo
    const swiper = new Swiper('.case-study-slider', {
        loop: true,
        slidesPerView: 1,
        spaceBetween: 30,
        pagination: { el: '.swiper-pagination', clickable: true },
        breakpoints: {
            768: { slidesPerView: 2, spaceBetween: 30 },
            1024: { slidesPerView: 3, spaceBetween: 30 }
        },
        autoplay: { delay: 5000, disableOnInteraction: false },
    });
});

// Logica per l'effetto glow del cursore
const glow = document.getElementById('cursor-glow');
if (glow) {
    document.addEventListener('mousemove', (e) => {
        window.requestAnimationFrame(() => {
            glow.style.left = `${e.clientX}px`;
            glow.style.top = `${e.clientY}px`;
        });
    });
}