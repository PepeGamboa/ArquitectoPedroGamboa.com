# PGT Studio — Pedro Gamboa Téllez, Arquitecto

Sitio web profesional de portafolio arquitectónico. Disponible en **10 idiomas**: ES, EN, PT, FR, DE, IT, KO, ZH, JA, HI.

**URL:** [arquitectopedrogamboa.com](https://arquitectopedrogamboa.com)

## Stack
- HTML5 / CSS3 / JS Vanilla (sin frameworks)
- Fuentes: Cormorant Garamond + Inter (Google Fonts)
- Hosting: GitHub Pages

## Deploy en GitHub Pages
1. Ve a **Settings → Pages** en este repositorio
2. En **Source**, selecciona `Deploy from a branch`
3. Rama: `main`, carpeta: `/ (root)`
4. Guarda — el sitio estará en `https://pepegamboa.github.io/ArquitectoPedroGamboa.com/`

## Para conectar dominio propio
1. Crea archivo `CNAME` con el contenido: `arquitectopedrogamboa.com`
2. En tu proveedor DNS, agrega:
   - `A` → `185.199.108.153`
   - `A` → `185.199.109.153`
   - `A` → `185.199.110.153`
   - `A` → `185.199.111.153`
   - `CNAME www` → `pepegamboa.github.io`

## Personalización rápida
- **Número de WhatsApp:** busca `573000000000` en `index.html` y cámbialo por tu número real (con código de país, sin `+`)
- **Foto de perfil:** agrega imagen en `/images/pedro.jpg` y reemplaza el `.about-card-inner` con un `<img>`
- **Proyectos reales:** reemplaza `.project-img-1/2/3` con `background-image: url('../images/proyecto1.jpg')`
- **Nuevas traducciones:** edita `js/i18n.js`

## Contacto
- Email: arquitectopedrogamboa@gmail.com
- LinkedIn: [linkedin.com/in/arquitectopedroggamboa](https://www.linkedin.com/in/arquitectopedroggamboa/)
