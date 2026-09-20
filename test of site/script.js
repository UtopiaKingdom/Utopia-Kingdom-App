document.addEventListener('DOMContentLoaded', ()=>{
  // Create and insert background canvas
  const existing = document.getElementById('bgCanvas');
  let canvas = existing;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'bgCanvas';
    document.body.insertBefore(canvas, document.body.firstChild);
  }
  const ctx = canvas.getContext('2d');
  let DPR = Math.max(1, window.devicePixelRatio || 1);
  function resizeCanvas(){
    const w = window.innerWidth; const h = window.innerHeight;
    canvas.width = Math.round(w * DPR); canvas.height = Math.round(h * DPR);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  window.addEventListener('resize', resizeCanvas);
  // on resize, re-init stars/particles for correct density
  window.addEventListener('resize', ()=>{ initStars(); initParticles(); });

  // Starfield + moon + aurora
  const stars = [];
  function initStars(){
    const count = Math.min(140, Math.round((window.innerWidth*window.innerHeight)/60000));
    stars.length = 0;
    for(let i=0;i<count;i++){
      stars.push({
        x: Math.random()*window.innerWidth,
        y: Math.random()*window.innerHeight*0.8,
        r: Math.random()*1.3 + 0.3,
        tw: Math.random()*Math.PI*2,
        speed: Math.random()*0.02+0.002
      });
    }
  }

  // small floating particle glints to add subtle motion
  const particles = [];
  function initParticles(){
    const pcount = Math.min(60, Math.round((window.innerWidth*window.innerHeight)/150000));
    particles.length = 0;
    for(let i=0;i<pcount;i++){
      particles.push({
        x: Math.random()*window.innerWidth,
        y: Math.random()*window.innerHeight,
        r: Math.random()*1.6 + 0.6,
        vx: (Math.random()-0.5)*0.12,
        vy: -Math.random()*0.07 - 0.01,
        alpha: 0.3 + Math.random()*0.6,
        tw: Math.random()*Math.PI*2
      });
    }
  }

  let t = 0;
  function draw(){
    const w = canvas.width / DPR; const h = canvas.height / DPR;
    // If the page is hidden, run the background at low frequency to save CPU/GPU
    if (document.hidden) {
      // draw one subtle frame every 1200ms while hidden
      setTimeout(()=>{ requestAnimationFrame(draw); }, 1200);
      return;
    }
    ctx.clearRect(0,0,w,h);

    // subtle gradient sky
    const g = ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'#05020a');
    g.addColorStop(0.6,'#070614');
    g.addColorStop(1,'#06040a');
    ctx.fillStyle = g; ctx.fillRect(0,0,w,h);

    // aurora blobs (simple moving radial gradients)
    for(let i=0;i<3;i++){
      const px = (Math.sin(t*0.0005 + i*1.2)*0.5 + 0.5) * w;
      const py = h*0.25 + i*40;
      const rad = Math.max(w,h)*0.6 - i*80;
      const ag = ctx.createRadialGradient(px,py,10,px,py,rad);
      const alpha = 0.06 + i*0.02;
      // warm halo aurora (golden/white) to match traditional halo colors
      ag.addColorStop(0, `rgba(255,240,200,${alpha})`);
      ag.addColorStop(0.5, `rgba(220,170,70,${alpha*0.6})`);
      ag.addColorStop(1, 'rgba(10,6,18,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(px,py,rad,0,Math.PI*2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // (moon disabled when using video background)

    // particles (subtle glints)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for(const p of particles){
      p.x += p.vx; p.y += p.vy; p.tw += 0.01;
      if (p.y < -20) p.y = h + Math.random()*40;
      if (p.x < -40) p.x = w + Math.random()*40;
      if (p.x > w+40) p.x = -Math.random()*40;
      const pulse = 0.6 + 0.4*Math.sin(p.tw);
      const rad = p.r * (2 + pulse*1.4);
      const pg = ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,rad);
      pg.addColorStop(0, `rgba(255,245,200,${p.alpha * 0.9})`);
      pg.addColorStop(0.5, `rgba(255,210,120,${p.alpha * 0.25})`);
      pg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(p.x,p.y,rad,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();

    // stars
    ctx.fillStyle = '#fff';
    for(const s of stars){
      s.tw += s.speed;
      const a = 0.5 + 0.5*Math.sin(s.tw);
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    t += 16;
    requestAnimationFrame(draw);
  }

  // initialize
  resizeCanvas(); initStars(); initParticles(); draw();

  // Insert background video and position canvas behind it
  (function initBgVideo(){
    const remoteUrl = 'https://motionbgs.com/media/53/black-hole.960x540.mp4';
    const localUrl = 'assets/black-hole.mp4';

    function createAndInsertVideo(src){
      const video = document.createElement('video');
      video.id = 'bgVideo';
      video.src = src;
      video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.style.position = 'fixed'; video.style.inset = '0'; video.style.width = '100%'; video.style.height = '100%';
      video.style.objectFit = 'cover'; video.style.zIndex = '0'; video.style.pointerEvents = 'none';
      document.body.insertBefore(video, document.body.firstChild);
      // apply responsive auto-scale and dim defaults
      document.documentElement.style.setProperty('--bg-brightness', '0.46');
      // choose scale based on viewport to avoid excessive zoom
      const vw = Math.max(window.innerWidth, 960);
      const scale = vw >= 3840 ? 1.0 : (vw >= 1920 ? 1.02 : 1.06);
      document.documentElement.style.setProperty('--bg-scale', String(scale));
      return video;
    }

    function applyFallback(reason){
      console.warn('Using background fallback:', reason);
      // remove any video if present
      const v = document.getElementById('bgVideo'); if (v && v.parentNode) v.parentNode.removeChild(v);
      canvas.style.zIndex = '0';
      // use local svg as fallback background
      document.body.style.backgroundImage = 'url("anime.svg")';
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundPosition = 'center';
    }

    // Try local file first (fast failure if missing). Check two possible local paths.
    const altLocal = 'scripts/assets/black-hole.mp4';
    function tryUrl(url){
      return fetch(url, {method:'HEAD'}).then(r=> ({ok: r.ok, url})).catch(()=> ({ok:false, url}));
    }
    Promise.all([tryUrl(localUrl), tryUrl(altLocal)]).then(results=>{
      const localFound = results.find(r=>r.ok);
      const src = localFound ? localFound.url : remoteUrl;
      const video = createAndInsertVideo(src);
      canvas.style.zIndex = '-1';
      video.addEventListener('error', ()=>{ applyFallback(src === remoteUrl ? 'remote video error' : 'local video error'); });
      video.addEventListener('loadeddata', ()=>{
        console.log('bg video ready', src);
        // slightly reduce brightness if video is very vivid
        document.documentElement.style.setProperty('--bg-brightness', '0.48');
      });
      const p = video.play(); if (p && p.catch) p.catch(()=>applyFallback('autoplay blocked'));
    }).catch(()=>{
      const video = createAndInsertVideo(remoteUrl);
      canvas.style.zIndex = '-1';
      video.addEventListener('error', ()=>{ applyFallback('remote video error'); });
      const p = video.play(); if (p && p.catch) p.catch(()=>applyFallback('autoplay blocked'));
    });
  })();

  // Simple thumbnail preview
  const hero = document.getElementById('heroScreenshot');
  const thumbs = Array.from(document.querySelectorAll('.thumb'));
  thumbs.forEach(t=> t.addEventListener('click', ()=>{ const s = t.dataset.src; if (s && hero) hero.src = s; }));

  // Carousel initialization (finite 3-slide carousel centered on middle)
  (function initCarousel(){
    const carousel = document.querySelector('.carousel');
    if (!carousel) return;
    const track = carousel.querySelector('.track');
    const slides = Array.from(track.querySelectorAll('.slide'));

    // If on a small phone, render a simple stacked gallery rather than
    // interactive carousel to avoid drag/stick issues and improve UX.
    const mobileForceStack = window.innerWidth <= 420;
    let initialMobile = mobileForceStack;
    if (mobileForceStack) {
      slides.forEach(s => {
        s.style.display = 'block';
        s.style.width = '100%';
        s.style.height = 'auto';
        s.classList.remove('center','adj');
      });
      track.style.transform = 'none';
      track.style.transition = 'none';
      const prevBtn = carousel.querySelector('.chev.prev');
      const nextBtn = carousel.querySelector('.chev.next');
      if (prevBtn) prevBtn.style.display = 'none';
      if (nextBtn) nextBtn.style.display = 'none';
      // If viewport crosses mobile threshold, reload to re-init carousel
      window.addEventListener('resize', ()=>{
        const nowMobile = window.innerWidth <= 420;
        if (nowMobile !== initialMobile) location.reload();
      });
      return;
    }

    // Make sure slide content is horizontally centered so side previews align
    slides.forEach(s => {
      s.style.display = 'flex';
      s.style.justifyContent = 'center';
      s.style.alignItems = 'center';
      s.style.boxSizing = 'border-box';
      const img = s.querySelector('img');
      if (img) {
        img.style.display = 'block';
        img.style.margin = '0 auto';
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
      }
    });
    const prevBtn = carousel.querySelector('.chev.prev');
    const nextBtn = carousel.querySelector('.chev.next');

    // We expect exactly three slides; start centered on the middle one (index 1)
    const minSlides = slides.length;
    let idx = Math.min(1, Math.max(0, Math.floor(minSlides/2)));
    let isDragging = false, startX = 0;
    // track current translate to avoid layout reads during pointermove
    let currentTranslate = 0, startTranslate = 0, rafPending = false, dragDx = 0;

    function getSlideSize(){
      const s = slides[0]; if (!s) return {w:640,g:18};
      const w = s.getBoundingClientRect().width; const gap = parseFloat(getComputedStyle(track).gap) || 18; return {w, g: gap};
    }

    function clamp(v){ return Math.max(0, Math.min(slides.length-1, v)); }

    function setIndex(i, instant){
      idx = clamp(i);
      const viewport = carousel.querySelector('.carousel-viewport');
      const vpRect = viewport.getBoundingClientRect();
      const vpW = vpRect.width;
      // compute slide center relative to the track and align it to viewport center
      const trackRect = track.getBoundingClientRect();
      const target = slides[idx];
      const slideRect = target.getBoundingClientRect();
      const slideCenterInTrack = (slideRect.left - trackRect.left) + slideRect.width/2;
      const desiredX = (vpW / 2) - slideCenterInTrack;
      if (instant) track.style.transition = 'none'; else track.style.transition = '';
      track.style.transform = `translate3d(${desiredX}px,0,0)`;
      // cache current translate so pointermove doesn't read layout
      currentTranslate = desiredX;
      slides.forEach((s,i)=>{ s.classList.toggle('center', i===idx); s.classList.toggle('adj', Math.abs(i-idx)===1); });
      // disable chevrons at ends
      if (prevBtn) prevBtn.disabled = (idx === 0);
      if (nextBtn) nextBtn.disabled = (idx === slides.length-1);
    }

    function prev(){ setIndex(idx-1); }
    function next(){ setIndex(idx+1); }

    prevBtn && prevBtn.addEventListener('click', prev);
    nextBtn && nextBtn.addEventListener('click', next);

    // pointer drag handlers (support touch)
    track.addEventListener('pointerdown', (e)=>{
      isDragging = true; startX = e.clientX; startTranslate = currentTranslate; track.style.transition = 'none'; dragDx = 0;
      // Avoid pointer capture so the pointer isn't locked to the element which can cause the mouse to 'stick'
    });
    track.addEventListener('pointermove', (e)=>{
      if (!isDragging) return;
      // avoid expensive layout reads inside pointermove — compute via cached startTranslate
      dragDx = e.clientX - startX;
      if (!rafPending){
        rafPending = true;
        requestAnimationFrame(()=>{
          const x = startTranslate + dragDx;
          track.style.transform = `translate3d(${x}px,0,0)`;
          rafPending = false;
        });
      }
    }, {passive:true});
    track.addEventListener('pointerup', (e)=>{
      if (!isDragging) return;
      isDragging = false;
      const dx = e.clientX - startX;
      const threshold = 80;
      if (dx < -threshold) setIndex(idx+1);
      else if (dx > threshold) setIndex(idx-1);
      else setIndex(idx);
    });
    // If the pointer leaves the track while dragging, cancel the drag to avoid
    // leaving the page in a stuck state.
    track.addEventListener('pointerleave', (e)=>{
      if (!isDragging) return;
      isDragging = false;
      setIndex(idx);
    });
    track.addEventListener('pointercancel', ()=> setIndex(idx));

    // keyboard support
    carousel.tabIndex = 0; carousel.addEventListener('keydown', (e)=>{ if (e.key === 'ArrowLeft') prev(); if (e.key === 'ArrowRight') next(); });

    // resize handler to re-center
    window.addEventListener('resize', ()=> setIndex(idx, true));

    // initial layout center on middle slide
    setIndex(1, true);
  })();

  // Simple reveal for cards
  const reveals = Array.from(document.querySelectorAll('.card, .hero-copy'));
  const io = new IntersectionObserver((entries)=>{ entries.forEach(e=>{ if (e.isIntersecting) e.target.classList.add('show'); }); }, {threshold:0.18});
  reveals.forEach(r=> io.observe(r));

  // Live stats: bots fixed at 3, users 20-50 simulated, signals random
  const usersEl = document.getElementById('stat-users');
  const botsEl = document.getElementById('stat-bots');
  const sigEl = document.getElementById('stat-signals');
  function setNum(el, n){ if (!el) return; el.textContent = String(n); }
  setNum(botsEl, 3);
  let users = Math.floor(Math.random()*31) + 20; setNum(usersEl, users);
  let signals = Math.floor(Math.random()*12)+2; setNum(sigEl, signals);
  setInterval(()=>{ users += Math.floor(Math.random()*3-1); users = Math.max(1, Math.min(50, users)); signals += Math.floor(Math.random()*3-1); signals = Math.max(0, signals); setNum(usersEl, users); setNum(sigEl, signals); }, 4500);

  // Debug helper: warn if an image is being upscaled (rendered > natural)
  (function checkImages(){
    const imgs = Array.from(document.querySelectorAll('.slide img'));
    imgs.forEach(img => {
      img.addEventListener('load', ()=>{
        try{
          const naturalW = img.naturalWidth || 0;
          const naturalH = img.naturalHeight || 0;
          const rect = img.getBoundingClientRect();
          const renderedW = Math.round(rect.width * (window.devicePixelRatio || 1));
          if (naturalW > 0 && renderedW > naturalW) {
            console.warn('Image upscaled (may blur):', img.src, {naturalW, renderedW});
          } else {
            console.log('Image OK:', img.src, {naturalW, renderedW});
          }
        }catch(e){/* ignore */}
      }, {once:true});
    });
  })();

  

  // Smooth scroll handler for in-page links with optional header offset
  (function smoothAnchors(){
    const header = document.querySelector('.topbar');
    const headerHeight = () => header ? header.getBoundingClientRect().height + 8 : 0;
    const anchors = Array.from(document.querySelectorAll('a[href^="#"]'));
    anchors.forEach(a => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        if (!href || href === '#') return;
        const target = document.querySelector(href);
        if (!target) return;
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - headerHeight();
        window.scrollTo({ top, behavior: 'smooth' });
        // update history without jumping
        if (history.pushState) history.pushState(null, '', href);
      });
    });
  })();
});
