document.addEventListener('alpine:init', () => {
     // Inizializza lo Swiper per le Storie di Successo
    const swiper = new Swiper('.case-study-slider', {
        loop: true,
        slidesPerView: 1,
        spaceBetween: 30,
        pagination: {
            el: '.swiper-pagination',
            clickable: true,
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
            disableOnInteraction: false,
        },
    });
});

const glow = document.getElementById('cursor-glow');
if (glow) {
    document.addEventListener('mousemove', (e) => {
        window.requestAnimationFrame(() => {
            glow.style.left = `${e.clientX}px`;
            glow.style.top = `${e.clientY}px`;
        });
    });
}