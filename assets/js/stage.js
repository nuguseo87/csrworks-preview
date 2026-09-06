/* stage.js — 사회공헌사업단 무대 엔진 + 공용 헤더·폼 클라이언트
   계약: docs/CONTRACT.md §5(인터페이스·상태기계·입력·이벤트·헤더) · §7-1(폼) · BUILD_PLAN §6-1 + 홍회장 override(휠 병행)
   단일 IIFE, defer. 프레임워크·의존성 0. 애니메이션은 CSS(transform/opacity)가 그리고 JS는 클래스·속성만 바꾼다. */
(function () {
  'use strict';

  var RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var reducedMotion = function () { return !!RM.matches; };
  var qs = function (sel, root) { return (root || document).querySelector(sel); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var on = function (el, type, fn, opts) { el.addEventListener(type, fn, opts); return function () { el.removeEventListener(type, fn, opts); }; };
  var emit = function (el, name, detail) { el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} })); };
  var homeHref = function () { var a = qs('.site-header__logo'); return (a && a.getAttribute('href')) || '/'; };

  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  /* ════════════════════════════════════════════════ 무대 엔진 (§5-1 ~ §5-5) */
  function createStage(stageEl) {
    var dataEl = qs('#scenes-data');
    var data = null;
    try { data = dataEl ? JSON.parse(dataEl.textContent) : null; } catch (e) { data = null; }
    if (!data || !Array.isArray(data.scenes) || !data.scenes.length) {
      console.warn('[CSStage] #scenes-data 없음 또는 파싱 실패 — 무대 엔진을 시작하지 않습니다.');
      return null;
    }
    var scenes = data.scenes.slice().sort(function (a, b) { return a.index - b.index; });
    var N = scenes.length;
    var cfg = {
      wheel: Object.assign({ enabled: true, thresholdPx: 120, lockMs: 700, minWidth: 1200 }, data.wheel || {}),
      swipe: Object.assign({ thresholdPx: 40, maxAngleDeg: 30 }, data.swipe || {}),
      video: Object.assign({ crossfadeMs: 400, preloadNextBeforeMs: 2000 }, data.video || {}),
      text: Object.assign({ outMs: 200, inMs: 400 }, data.text || {}),
      stage: Object.assign({ initialIndex: 0, reverseEntryParam: 'from=amorfati', reverseEntryIndex: N - 1, reverseEntryDirection: -1, fallbackSeconds: 16 }, data.stage || {}),
      controls: data.controls || {},
      announce: data.announce || '{n}번째 장면, {name}',
      hintKey: data.hintKey || 'cs_hint_seen'
    };

    /* DOM */
    var sceneEls = qsa('article.scene', stageEl).sort(function (a, b) { return +a.dataset.sceneIndex - +b.dataset.sceneIndex; });
    var segs = qsa('button.pager__seg', stageEl).sort(function (a, b) { return +a.dataset.sceneIndex - +b.dataset.sceneIndex; });
    var prevBtn = qs('button.pager__prev', stageEl), nextBtn = qs('button.pager__next', stageEl), pauseBtn = qs('button.pager__pause', stageEl);
    var videoBtn = qs('button.pager__video', stageEl);   /* 선택 요소: 모바일 영상 재생 옵트인(없어도 동작) */
    var hintEl = qs('.pager__hint', stageEl);
    var liveEl = (stageEl.parentNode && qs('.stage__live', stageEl.parentNode)) || qs('.stage__live');
    var listItems = qsa('button.scene-list__item');
    var slots = qsa('.stage__video[data-slot]', stageEl).map(function (el) {
      return { el: el, poster: qs('img.stage__poster', el), video: qs('video.stage__vid', el), sceneId: null };
    });
    if (sceneEls.length !== N || segs.length !== N || slots.length < 2) {
      console.warn('[CSStage] DOM 계약 불일치 (scene ' + sceneEls.length + ', seg ' + segs.length + ', slot ' + slots.length + ')');
      if (!sceneEls.length || !segs.length) return null;
    }

    /* 상태 */
    var index = 0, dir = 1;
    var reasons = new Set();
    var wheelOn = cfg.wheel.enabled !== false && stageEl.dataset.wheel !== 'off';
    var cleanups = [];
    var preloadTimer = 0, preloadAutoTimer = 0, swapToken = 0, fallbackTimer = 0, fallbackStart = 0, fallbackRemain = 0, usingFallbackTimer = false;
    var hintVisible = false;
    var saveData = !!(navigator.connection && navigator.connection.saveData);
    /* 상한을 767.98 로 둔다: 옵트인 버튼(.pager__video)을 숨기는 CSS 가 min-width:768 이라
       768 을 양쪽에 걸치면 '영상도 없고 켤 버튼도 없는' 폭이 1px 생긴다 */
    /* 09-06 실기기 확인 후 변경: 모바일에서도 영상을 바로 튼다.
       클립이 1.2~3.7MB 로 작고, 「재생 버튼을 눌러야 나오는 무대」는 첫인상에서 영상이 없는 것과 같다.
       데이터 절약 모드(saveData)·모션 민감(reduced-motion)에서는 종전대로 포스터만 보여준다. */
    var mobileNoVideo = function () { return false; };
    /* 모바일(hover:none·≤768) 무영상 경로는 사용자가 명시적으로 켤 때만 해제된다(BUILD_PLAN §8 '재생 버튼을 누르면 로드').
       트리거 DOM(.pager__video)이 있으면 자동으로 연결하고, 없으면 공개 API(CSStage.enableVideo())로도 켤 수 있다. */
    var videoOptIn = false;
    var mobileNoVideoNow = function () { return mobileNoVideo() && !videoOptIn; };
    var canPlayVideo = function (s) { return !!(s.hasVideo && !reducedMotion() && !saveData && !mobileNoVideoNow()); };
    var norm = function (i) { return ((i % N) + N) % N; };
    var paused = function () { return reasons.size > 0; };
    var liveSlot = function () { return slots.find(function (s) { return s.el.classList.contains('is-live'); }) || slots[0]; };
    var idleSlot = function () { var l = liveSlot(); return slots.find(function (s) { return s !== l; }) || slots[1]; };

    /* ── 라이브 공지 (§7-2: 사용자 조작 또는 정지 상태 전환에서만) */
    function announce(i) {
      if (!liveEl) return;
      var msg = cfg.announce.replace('{n}', String(i + 1)).replace('{name}', scenes[i].name);
      if (liveEl.textContent === msg) { liveEl.textContent = ''; requestAnimationFrame(function () { liveEl.textContent = msg; }); }
      else liveEl.textContent = msg;
    }

    /* ── 첫 방문 힌트 */
    function initHint() {
      var seen = null;
      try { seen = localStorage.getItem(cfg.hintKey); } catch (e) { seen = '1'; }
      if (!seen && hintEl) { hintEl.hidden = false; hintVisible = true; }
    }
    function hideHint() {
      if (!hintVisible) return;
      hintVisible = false;
      if (hintEl) hintEl.hidden = true;
      try { localStorage.setItem(cfg.hintKey, '1'); } catch (e) { /* 저장 불가 환경 */ }
    }

    /* ── 스윕(체류 타이머) — CSS 애니메이션 seg-sweep + animationend 가 전진을 구동
       ⚠ seg-sweep 은 `.pager__seg::before` 의사요소에 선언돼 있다. animation-play-state 는 비상속이라
       호스트 <button> 의 인라인 스타일로는 절대 멈추지 않는다(a11y-1·fidelity-1). 의사요소 애니메이션을
       Web Animations API 로 직접 잡아 pause()/play() 하고, 그게 불가능한 환경에서는 JS 폴백 타이머가 전진을 구동한다.
       CSS 쪽 훅 `.stage[data-paused="true"] .pager__seg.is-sweeping::before{animation-play-state:paused}` 이
       stage.css §7 에 있다(2차 수정에서 추가). 둘은 병행이며, WAAPI 를 못 쓰는 환경의 시각 정지는 CSS 가 책임진다. */
    var canGetAnimations = typeof Element !== 'undefined' && Element.prototype && typeof Element.prototype.getAnimations === 'function';
    function sweepAnimations(seg) {
      if (!seg || !canGetAnimations) return [];
      var list = [];
      try { list = seg.getAnimations({ subtree: true }) || []; }
      catch (e) { try { list = seg.getAnimations() || []; } catch (e2) { list = []; } }
      return list.filter(function (a) { return !a.animationName || a.animationName === 'seg-sweep'; });
    }
    function setSweepPlayState(running) {
      var seg = segs[index];
      if (!seg) return;
      sweepAnimations(seg).forEach(function (a) {
        /* 이미 끝난 애니메이션에 play() 를 부르면 처음부터 다시 돈다 — 건드리지 않는다(전진은 resume 이 처리) */
        if (running && a.playState === 'finished') return;
        try { if (running) a.play(); else a.pause(); } catch (e) { /* noop */ }
      });
    }
    function sweepFinished(seg) {
      return sweepAnimations(seg).some(function (a) { return a.playState === 'finished'; });
    }
    function restartSweep(i) {
      var dwell = scenes[i].dwellSeconds || cfg.stage.fallbackSeconds;
      segs.forEach(function (s) { s.classList.remove('is-sweeping'); });
      var seg = segs[i];
      if (!seg) return;
      seg.style.setProperty('--cs-scene-dwell', dwell + 's');
      /* reduced-motion: 스윕 모션 자체를 붙이지 않는다(.is-active::before 가 채운 상태로 남는다).
         CSS 의 RM 블록이 특이성에서 지더라도 모션이 재생될 여지가 없다. */
      if (reducedMotion()) { armFallbackTimer(dwell); schedulePreload(i, dwell); return; }
      void seg.offsetWidth;
      seg.classList.add('is-sweeping');
      if (!sweepDetected) detectSweepAnimation(seg);
      if (paused()) setSweepPlayState(false);
      armFallbackTimer(dwell);
      schedulePreload(i, dwell);
    }
    function advance() { goTo(norm(index + dir), 'auto'); }
    function onAnimationEnd(e) {
      if (e.animationName !== 'seg-sweep') return;
      if (usingFallbackTimer) return;
      if (e.target !== segs[index]) return;
      /* 정지 중에 도착한 완료 신호는 버리지 않고 보류했다가 resume 에서 소비한다(자동 전진 영구 정지 방지) */
      if (paused()) { pendingAdvance = true; return; }
      advance();
    }
    /* CSS 미로드(스타일 시트 부재)·WAAPI 미지원 환경 보험: 의사요소 스윕을 JS 로 제어할 수 없으면 타이머가 대신 전진한다.
       .is-sweeping 이 붙은 직후 1회만 판정. reduced-motion 에서는 스윕을 붙이지 않으므로 판정도 하지 않는다 */
    var sweepDetected = false, pendingAdvance = false;
    function detectSweepAnimation(seg) {
      sweepDetected = true;
      var cssSweep = false;
      try {
        var name = getComputedStyle(seg, '::before').animationName || '';
        cssSweep = name.indexOf('seg-sweep') !== -1;
      } catch (e) { cssSweep = false; }
      var waapiSweep = cssSweep && sweepAnimations(seg).length > 0;
      usingFallbackTimer = !cssSweep || !waapiSweep;
      if (!cssSweep && !reducedMotion()) console.warn('[CSStage] seg-sweep 키프레임 미검출 — JS 폴백 타이머로 전진합니다 (stage.css 확인).');
      else if (usingFallbackTimer && !reducedMotion()) console.warn('[CSStage] 의사요소 스윕을 JS 로 제어할 수 없어 폴백 타이머로 전진합니다.');
    }
    function armFallbackTimer(dwell) {
      clearTimeout(fallbackTimer); fallbackRemain = dwell * 1000; fallbackStart = 0;
      if (!usingFallbackTimer || paused()) return;
      fallbackStart = Date.now();
      fallbackTimer = setTimeout(function () { if (!paused()) advance(); }, fallbackRemain);
    }
    function pauseFallback() { if (!usingFallbackTimer || !fallbackStart) return; clearTimeout(fallbackTimer); fallbackRemain = Math.max(0, fallbackRemain - (Date.now() - fallbackStart)); fallbackStart = 0; }
    function resumeFallback() { if (!usingFallbackTimer || fallbackStart) return; fallbackStart = Date.now(); clearTimeout(fallbackTimer); fallbackTimer = setTimeout(function () { if (!paused()) advance(); }, fallbackRemain); }

    /* ── 텍스트 교체 (CSS 200ms out / 400ms in) */
    function swapText(from, to, instant) {
      if (instant) sceneEls.forEach(function (el) { el.style.transition = 'none'; });
      sceneEls.forEach(function (el, k) {
        var active = k === to;
        el.classList.toggle('is-active', active);
        if (active) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
      });
      if (instant) { void stageEl.offsetWidth; requestAnimationFrame(function () { sceneEls.forEach(function (el) { el.style.transition = ''; }); }); }
    }
    function updatePager(i) {
      segs.forEach(function (s, k) {
        var active = k === i;
        s.setAttribute('aria-selected', active ? 'true' : 'false');
        s.setAttribute('tabindex', active ? '0' : '-1');
        s.classList.toggle('is-active', active);
      });
      /* 목차의 상태 원천은 aria-current 하나 (CSS 훅도 `[aria-current="true"]`) — a11y-15 */
      listItems.forEach(function (b) {
        if (+b.dataset.sceneIndex === i) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
    }

    /* ── 영상 2슬롯 크로스페이드 (§5-3 swapVideo) */
    /* 소스를 실제로 바꿨을 때만 true — 호출부가 load() 재호출(=버퍼 폐기) 여부를 판단한다 */
    function setSources(video, s) {
      if (video.dataset.scene === s.id) return false;
      while (video.firstChild) video.removeChild(video.firstChild);
      video.classList.remove('is-playing');
      if (s.hasWebm) { var w = document.createElement('source'); w.src = s.webm; w.type = 'video/webm'; video.appendChild(w); }
      var m = document.createElement('source'); m.src = s.mp4; m.type = 'video/mp4'; video.appendChild(m);
      video.dataset.scene = s.id;
      return true;
    }
    function clearSources(video) {
      if (!video.firstChild && !video.dataset.scene) return;
      while (video.firstChild) video.removeChild(video.firstChild);
      delete video.dataset.scene;
      video.classList.remove('is-playing');
      video.removeAttribute('src');
      try { video.load(); } catch (e) { /* noop */ }
    }
    function sameUrl(a, b) { try { return new URL(a, location.href).href === new URL(b, location.href).href; } catch (e) { return a === b; } }
    function commitSlot(next, prev, i, hasVideo) {
      next.el.classList.add('is-live');
      if (prev !== next) {
        prev.el.classList.remove('is-live');
        setTimeout(function () { if (!prev.el.classList.contains('is-live')) { try { prev.video.pause(); } catch (e) { /* noop */ } } }, cfg.video.crossfadeMs);
      }
      emit(stageEl, 'cs:videoswap', { index: i, slot: next.el.dataset.slot, hasVideo: hasVideo });
    }
    function swapVideo(i) {
      if (slots.length < 2) return;
      var s = scenes[i];
      var prev = liveSlot(), next = idleSlot();
      var token = ++swapToken;
      if (!canPlayVideo(s)) {
        var already = !prev.video.dataset.scene && prev.poster.getAttribute('src') && sameUrl(prev.poster.getAttribute('src'), s.poster);
        if (already) { emit(stageEl, 'cs:videoswap', { index: i, slot: prev.el.dataset.slot, hasVideo: false }); return; }
        next.poster.src = s.poster;
        clearSources(next.video);
        /* 포스터 디코드 후 크로스페이드(최대 500ms 대기) — 어두운 카드 배경 위라 흰 플래시는 없다 */
        var committed = false;
        var commitPoster = function () { if (committed || token !== swapToken) return; committed = true; commitSlot(next, prev, i, false); };
        if (next.poster.complete) commitPoster();
        else { next.poster.addEventListener('load', commitPoster, { once: true }); next.poster.addEventListener('error', commitPoster, { once: true }); setTimeout(commitPoster, 500); }
        return;
      }
      next.poster.src = s.poster;
      /* 프리로드가 이미 이 장면을 채워 둔 슬롯이면 load() 를 다시 부르지 않는다.
         load() 는 리소스 선택을 리셋해 진행 중인 페치·버퍼를 폐기하므로 프리로드가 무효가 된다(fidelity-3·perf-mobile-4) */
      var changed = setSources(next.video, s);
      next.video.preload = 'auto';
      if (changed) { try { next.video.load(); } catch (e) { /* noop */ } }
      /* 사용자가 멈춘 상태(정지 버튼·Space·숨김 탭·RM)에서 장면을 넘기거나 영상을 켰을 때 다시 재생하지 않는다 — WCAG 2.2.2 */
      if (!videoMustPause()) { var p = next.video.play(); if (p && p.catch) p.catch(function () { /* autoplay 거부 시 포스터 유지 */ }); }
      var done = false;
      var finish = function () {
        if (done || token !== swapToken) return;
        done = true;
        next.video.removeEventListener('loadeddata', finish);
        next.video.removeEventListener('canplay', finish);
        commitSlot(next, prev, i, true);
      };
      /* 첫 프레임(loadeddata) 기준 커밋 + 타임아웃 — 콜드 네트워크에서 포스터 상태로 커밋되는 하드 팝을 줄인다.
         🔴 상한 1200ms 는 텍스트(200 out + 400 in = 600ms)보다 최대 0.6초 늦게 400ms 크로스페이드를 시작해
         「글은 이미 새 장면, 그림은 두 장면이 반투명으로 겹침」 상태를 만들었다(캡처 4/4 재현 · FINDINGS fresh-4).
         상한을 텍스트 완료 시점(600ms)으로 내려 두 전환이 같은 창 안에서 끝나게 한다. */
      if (next.video.readyState >= 2) finish();
      next.video.addEventListener('loadeddata', finish);
      next.video.addEventListener('canplay', finish);
      setTimeout(finish, 600);
    }
    /* BUILD_PLAN §8: 다음 장면(dir 방향)은 즉시 preload='metadata' 로 잡아 두고, 재생 2s 전에 'auto' 로 올린다.
       load() 는 슬롯당 1회(소스가 바뀔 때)만 — 중복 로드 금지 */
    /* 🔴 슬롯 전환이 아직 커밋되지 않았으면 idleSlot() 은 '들어오는 슬롯'(= 지금 장면)이다.
       거기에 다음 장면 소스를 심으면 진행 중인 장면의 버퍼를 버리고, 그 슬롯의 loadeddata 가
       swapVideo 의 finish 를 발화시켜 장면 i 의 텍스트 아래에 장면 i+1 의 영상이 뜬다. */
    function slotHoldsCurrent(slot) {
      var cur = scenes[index];
      if (slot.video && slot.video.dataset.scene === cur.id) return true;
      var ps = slot.poster && slot.poster.getAttribute('src');
      return !!(ps && sameUrl(ps, cur.poster));
    }
    function schedulePreload(i, dwell) {
      clearTimeout(preloadTimer); clearTimeout(preloadAutoTimer);
      var nx = scenes[norm(i + dir)];
      if (!canPlayVideo(nx)) return;
      var dwellMs = dwell * 1000;
      /* 크로스페이드가 끝난 뒤에 유휴 슬롯을 건드린다(진행 중인 페이드아웃 프레임을 지우지 않도록) */
      var metaAt = Math.min(cfg.video.crossfadeMs + 60, Math.max(0, dwellMs - cfg.video.preloadNextBeforeMs));
      var deadline = Date.now() + Math.max(0, dwellMs - cfg.video.preloadNextBeforeMs);
      var tryMeta = function () {
        if (i !== index) return;                                   /* 이미 다른 장면으로 넘어갔다 */
        var slot = idleSlot();
        if (slot.el.classList.contains('is-live') || slotHoldsCurrent(slot)) {
          /* 커밋 전이다 — 200ms 뒤 다시 본다(콜드 네트워크에서 커밋이 최대 1200ms 늦는다) */
          if (Date.now() < deadline) preloadTimer = setTimeout(tryMeta, 200);
          return;
        }
        if (setSources(slot.video, nx)) {
          slot.video.preload = 'metadata';
          try { slot.video.load(); } catch (e) { /* noop */ }
        }
      };
      preloadTimer = setTimeout(tryMeta, metaAt);
      preloadAutoTimer = setTimeout(function () {
        if (i !== index) return;
        var slot = idleSlot();
        if (slot.el.classList.contains('is-live')) return;
        if (slot.video.dataset.scene !== nx.id) return;   /* 프리로드된 슬롯일 때만 — 중복 load() 금지 */
        if (slot.video.preload !== 'auto') slot.video.preload = 'auto';
      }, Math.max(0, dwellMs - cfg.video.preloadNextBeforeMs));
    }

    /* ── goTo (§5-3) */
    /* 전환 직전에 포커스가 있던 장면이 visibility:hidden 으로 사라지면 포커스가 body 로 떨어진다(a11y-6).
       활성 장면 안의 대응 요소(첫 CTA) 또는 활성 세그먼트로 옮겨 무대 안에 붙잡아 둔다. */
    function keepFocusInStage(ae) {
      if (!ae || !stageEl.contains(ae) || !ae.closest) return;
      var sc = ae.closest('.scene');
      if (!sc || sc.classList.contains('is-active')) return;
      var t = qs('.scene.is-active .btn', stageEl) || segs[index];
      if (!t) return;
      try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
    }
    /* 무대 밖(드롭다운 카드·모바일 메뉴)에서 장면을 점프한 경우의 포커스 착지점.
       keepFocusInStage 는 「무대 안에서 사라지는 요소를 들고 있던 포커스」만 구제하므로(ae 가 무대 밖이면 즉시 return)
       점프 경로는 따로 처리해야 한다. 트리거가 display:none 으로 닫히면 포커스가 <body> 로 떨어져
       키보드 사용자는 매번 문서 맨 위부터 다시 Tab 해야 했다 — a11y-live-1.
       착지점은 그 장면의 논리적 시작점 = 장면 제목(h2.scene__h1). 제목은 원래 포커스 대상이 아니라
       프로그램 포커스용 tabindex="-1" 을 이 순간에 붙인다(SSR 마크업·DOM 계약은 그대로 두고, Tab 순서에도 안 들어간다).
       제목이 없으면 활성 세그먼트(role=tab, 「n번째 장면, 이름」)로 떨어진다. */
    function focusSceneStart() {
      var h = qs('.scene.is-active .scene__h1', stageEl);
      if (h && !h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      var t = h || segs[index] || qs('.scene.is-active .btn', stageEl);
      if (!t) return false;
      try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
      return document.activeElement === t;
    }
    function goTo(i, src, instant, initial) {
      src = src || 'user';
      i = norm(i);
      if (i === index && src === 'auto') return;
      var from = index;
      var wasFocused = document.activeElement;
      index = i;
      stageEl.dataset.index = String(i);
      /* 그림 요청을 먼저 띄우고 텍스트를 바꾼다 — 두 전환의 시작점을 붙여 「글만 먼저 바뀐」 구간을 줄인다(fresh-4) */
      swapVideo(i);
      swapText(from, i, !!instant);
      updatePager(i);
      keepFocusInStage(wasFocused);
      restartSweep(i);
      /* 포커스가 이미 해당 탭에 있으면 SR 이 탭 선택을 읽으므로 라이브 공지는 생략(이중 공지 방지).
         초기 위치 맞춤(initial)은 로드 중이므로 침묵 — §7-2 */
      if (!initial && (src === 'user' || paused()) && document.activeElement !== segs[i]) announce(i);
      if (src === 'auto' && !initial) hideHint();
      emit(stageEl, 'cs:scenechange', { from: from, to: i, src: src, dir: dir });
    }
    /* 사용자 조작은 dir 과 무관하게 DOM 순서로 움직인다(→ = 다음 탭). 역방향은 자동 전진(advance)에만 적용 — a11y-4 */
    function next(src) { goTo(index + 1, src || 'user'); }
    function prev(src) { goTo(index - 1, src || 'user'); }

    /* ── 정지 사유 집합 (§5-3 pause/resume) */
    /* 토글 버튼은 라벨 고정 + aria-pressed 변화 (ARIA APG). 라벨과 pressed 를 함께 뒤집으면
       「자동 전환 재생, 눌림」처럼 상태가 거꾸로 읽힌다 — a11y-12. 아이콘 교체는 유지. */
    /* 🔴 사용자 외 사유(reduced-motion)로 무대가 멈춰 있으면 버튼은 그 사실을 말해야 한다.
       옛 코드는 'user' 만 봐서 RM 초기화 경로에서 「지금 돌고 있으니 누르면 멈춘다」(aria-pressed=false +
       정지 글리프)로 말했고, 실제로 눌러도 resume() 이 reasons 에 남은 'rm' 때문에 조기 반환해 아무 일도
       일어나지 않았다 — WCAG 4.1.2 상태 불일치(a11y-live-5). RM 은 사용자가 OS 에서 정한 값이라
       이 버튼으로 풀 수 없으므로 aria-disabled 로 두고 이유를 라벨로 말한다. */
    function motionLocked() { return reasons.has('rm'); }
    function syncPauseBtn() {
      if (!pauseBtn) return;
      var userPaused = reasons.has('user');
      var locked = motionLocked();
      pauseBtn.setAttribute('aria-pressed', userPaused ? 'true' : 'false');
      var label = locked
        ? (cfg.controls.pauseLockedRm || pauseBtn.dataset.labelLockedRm || cfg.controls.pause || pauseBtn.dataset.labelPause)
        : (cfg.controls.pause || pauseBtn.dataset.labelPause);
      if (label && pauseBtn.getAttribute('aria-label') !== label) pauseBtn.setAttribute('aria-label', label);
      if (locked) pauseBtn.setAttribute('aria-disabled', 'true'); else pauseBtn.removeAttribute('aria-disabled');
      /* 글리프는 「지금 멈춰 있나」를 그린다 — 사유가 무엇이든 멈춰 있으면 재생 글리프 */
      var stopped = userPaused || locked;
      var ic = qs('.pager__icon--pause', pauseBtn), ip = qs('.pager__icon--play', pauseBtn);
      if (ic) ic.hidden = stopped;
      if (ip) ip.hidden = !stopped;
    }
    /* 영상 정지 사유는 사유 집합에서 매번 다시 계산한다. 사유 하나가 풀렸을 때 「스윕은 아직 정지,
       영상은 재생」 같은 조합이 정확히 복원돼야 한다 — 사유별 분기를 pause/resume 양쪽에 흩어 두면
       다른 사유가 남은 상태의 resume('user') 이 조기 반환하면서 영상만 멈춘 채 남는다(a11y-5 회귀) */
    function videoMustPause() { return reasons.has('hidden') || reasons.has('rm') || reasons.has('user'); }
    function syncVideoPlayState() {
      var v = liveSlot().video;
      if (!v || !v.dataset.scene) return;
      if (videoMustPause()) { try { v.pause(); } catch (e) { /* noop */ } }
      else { var p = v.play(); if (p && p.catch) p.catch(function () { /* noop */ }); }
    }
    function pause(r) {
      reasons.add(r);
      stageEl.dataset.paused = 'true';
      setSweepPlayState(false);
      pauseFallback();
      /* 사용자 정지(정지 버튼·Space)에서도 루프 영상을 멈춘다 — WCAG 2.2.2 (a11y-5) */
      syncVideoPlayState();
      syncPauseBtn();
      emit(stageEl, 'cs:pause', { reasons: Array.from(reasons) });
    }
    function resume(r) {
      var had = reasons.delete(r);
      if (reasons.size > 0) { if (had) { syncPauseBtn(); syncVideoPlayState(); } return; }
      if (!had && stageEl.dataset.paused === 'false') return;
      stageEl.dataset.paused = 'false';
      syncPauseBtn();
      /* 정지 중에 스윕이 끝나 버려진 전진이 있으면 먼저 소비한다 */
      var seg = segs[index];
      var stale = !!seg && !reducedMotion() && !usingFallbackTimer && sweepFinished(seg);
      if (pendingAdvance || stale) { pendingAdvance = false; emit(stageEl, 'cs:resume', { reasons: [] }); advance(); return; }
      if (seg && !reducedMotion() && (!seg.classList.contains('is-sweeping') || (!usingFallbackTimer && !sweepAnimations(seg).length))) {
        restartSweep(index);   /* 스윕이 없거나 붙잡을 애니메이션이 사라진 경우: 다시 건다 */
      } else {
        setSweepPlayState(true);
        resumeFallback();
      }
      syncVideoPlayState();
      emit(stageEl, 'cs:resume', { reasons: [] });
    }
    /* speak = 상태 변화를 라이브 영역으로 알린다. aria-pressed 변화는 그 버튼에 포커스가 있을 때만 읽히는데,
       Space 는 무대 어디서나(장면 CTA 링크 포함) 토글을 가로채므로 그 경로에는 공지가 필요하다(a11y-live-6) */
    function toggleUser(speak) {
      if (motionLocked()) return;   /* RM 잠금 중에는 토글이 아무 일도 하지 않는다 — 조용히 무시하지 말고 아예 받지 않는다 */
      if (reasons.has('user')) resume('user'); else pause('user');
      if (speak && liveEl) {
        var msg = reasons.has('user') ? (cfg.controls.pause || '') : (cfg.controls.play || '');
        if (msg) { liveEl.textContent = ''; requestAnimationFrame(function () { liveEl.textContent = msg; }); }
      }
    }

    /* ── 사용자 입력 (§5-4) */
    /* 모바일 목차는 카드 아래 접힘 밖이라 4~6번 장면에서는 활성 표시가 늘 화면 밖이다 — 장면을 바꿔도
       목차가 아무 반응을 보이지 않는 것처럼 보인다(FINDINGS mobile-11). 무대 안에서 장면을 넘긴 경우에만
       활성 행을 끌어온다(내비·메뉴 점프는 initSceneJumps 가 맨 위로 올리므로 건드리지 않는다). */
    function revealListItem() {
      var b = null;
      for (var k = 0; k < listItems.length; k++) if (+listItems[k].dataset.sceneIndex === index) { b = listItems[k]; break; }
      if (!b || !b.offsetParent) return;
      var r = b.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight)) return;
      try { b.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); }
      catch (e) { b.scrollIntoView(false); }
    }
    function userInput(fn) { return function (e) { hideHint(); fn(e); }; }
    segs.forEach(function (s) { cleanups.push(on(s, 'click', userInput(function () { goTo(+s.dataset.sceneIndex, 'user'); revealListItem(); }))); cleanups.push(on(s, 'animationend', onAnimationEnd)); });
    if (prevBtn) cleanups.push(on(prevBtn, 'click', userInput(function () { prev('user'); revealListItem(); })));
    if (nextBtn) cleanups.push(on(nextBtn, 'click', userInput(function () { next('user'); revealListItem(); })));
    if (pauseBtn) cleanups.push(on(pauseBtn, 'click', userInput(function () { toggleUser(); })));

    cleanups.push(on(document, 'keydown', function (e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      var ae = document.activeElement;
      var inStage = stageEl.contains(ae);
      var onBody = ae === document.body || ae === document.documentElement || ae === null;
      var key = e.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
        if (!inStage && !onBody) return;
        if (document.body.classList.contains('menu-open')) return;
        /* Home/End 는 페이지 이동 키다. 포커스가 무대 밖(body)이고 문서가 스크롤 가능하면 가로채지 않는다 — a11y-3 */
        if ((key === 'Home' || key === 'End') && !inStage && document.documentElement.scrollHeight > window.innerHeight + 1) return;
        var wasSeg = ae && ae.classList && ae.classList.contains('pager__seg');
        var inScene = !!(ae && ae.closest && ae.closest('.scene'));
        e.preventDefault(); hideHint();
        if (key === 'ArrowLeft') prev('user'); else if (key === 'ArrowRight') next('user'); else if (key === 'Home') goTo(0, 'user'); else goTo(N - 1, 'user');
        if (wasSeg) segs[index].focus();
        else if (inScene) { var t = qs('.scene.is-active .btn', stageEl) || segs[index]; if (t) { try { t.focus({ preventScroll: true }); } catch (e2) { t.focus(); } } }
        return;
      }
      if (key === ' ' || key === 'Spacebar') {
        if (!inStage) return;
        if (ae && ae.closest && ae.closest('.pager button')) return; /* 버튼 자체 활성화 우선 */
        e.preventDefault(); hideHint(); toggleUser(true);
      }
    }));

    /* 휠 병행(홍회장 override): 누적 ≥120px → ±1, 700ms 락, ≥1200 에서만 */
    var wheelAcc = 0, wheelLocked = false, wheelLockTimer = 0, wheelIdleTimer = 0;
    function onWheel(e) {
      if (!wheelOn || !window.matchMedia('(min-width:' + cfg.wheel.minWidth + 'px)').matches) return;
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
      if (Math.abs(dy) < Math.abs(e.deltaX)) return; /* 가로 스크롤은 무시 */
      if (document.body.classList.contains('menu-open')) return;
      if (wheelLocked) { wheelAcc = 0; e.preventDefault(); return; }
      /* 🔴 탈출 가드는 body 의 overflow 가 아니라 「문서에 실제로 남은 스크롤 여유」를 본다.
         옛 판정(getComputedStyle(body).overflowY !== 'hidden')은 두 방향 모두를 한 값에 묶어,
         ① 1280×620 처럼 잠금이 걸리지 않는 짧은 뷰포트에서 푸터가 화면 밖(y=621)인데도 마지막 장면까지
         휠을 가로챘고 ② 1440×900 에서는 body 계산값이 'hidden' 이라 가드 자체가 죽어 있었다(a11y-live-4). */
      var docEl = document.documentElement;
      var canScrollDown = docEl.scrollHeight - window.scrollY - window.innerHeight > 1;
      var canScrollUp = window.scrollY > 0;
      if (index === N - 1 && dy > 0 && canScrollDown) return;
      if (index === 0 && dy < 0 && canScrollUp) return;
      e.preventDefault();
      wheelAcc += dy;
      clearTimeout(wheelIdleTimer); wheelIdleTimer = setTimeout(function () { wheelAcc = 0; }, 400);
      if (Math.abs(wheelAcc) >= cfg.wheel.thresholdPx) {
        var sign = wheelAcc > 0 ? 1 : -1;
        wheelAcc = 0;
        hideHint();
        goTo(index + sign, 'user');
        wheelLocked = true;
        clearTimeout(wheelLockTimer);
        wheelLockTimer = setTimeout(function () { wheelLocked = false; }, cfg.wheel.lockMs);
      }
    }
    cleanups.push(on(stageEl, 'wheel', onWheel, { passive: false }));

    /* 스와이프: 가로·세로 모두 장면 전환 (09-06 실기기 확인 — 세로만 페이지 스크롤이면
       「위로 쓸어올렸는데 화면만 내려간다」가 되어 무대가 무대로 읽히지 않는다).
       위로 = 다음 · 아래로 = 이전 · 왼쪽 = 다음 · 오른쪽 = 이전.
       카드는 touch-action:none 이라 제스처가 페이지 스크롤에 먹히지 않는다.
       단 트랙이 실제로 넘칠 때(확대·짧은 폰)는 트랙 안 세로 제스처를 스크롤에 양보한다. */
    var touch = null;
    var trackScrollable = function (target) {
      var tr = target && target.closest ? target.closest('.stage__track') : null;
      return !!(tr && tr.scrollHeight > tr.clientHeight + 1);
    };
    cleanups.push(on(stageEl, 'touchstart', function (e) {
      var t = e.changedTouches[0];
      touch = { x: t.clientX, y: t.clientY, skip: trackScrollable(e.target) };
    }, { passive: true }));
    cleanups.push(on(stageEl, 'touchend', function (e) {
      if (!touch) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touch.x, dy = t.clientY - touch.y, skip = touch.skip; touch = null;
      if (skip) return;
      var ax = Math.abs(dx), ay = Math.abs(dy);
      if (Math.max(ax, ay) < cfg.swipe.thresholdPx) return;
      hideHint();
      if (ax >= ay) { if (dx < 0) next('user'); else prev('user'); }
      else { if (dy < 0) next('user'); else prev('user'); }
      revealListItem();
    }, { passive: true }));
    cleanups.push(on(stageEl, 'touchcancel', function () { touch = null; }, { passive: true }));

    /* 정지 조건: hover(마우스만) · focus-within · document.hidden */
    if (window.PointerEvent) {
      cleanups.push(on(stageEl, 'pointerenter', function (e) { if (e.pointerType === 'mouse') pause('hover'); }));
      cleanups.push(on(stageEl, 'pointerleave', function (e) { if (e.pointerType === 'mouse') resume('hover'); }));
    } else {
      cleanups.push(on(stageEl, 'mouseenter', function () { pause('hover'); }));
      cleanups.push(on(stageEl, 'mouseleave', function () { resume('hover'); }));
    }
    /* 포커스 정지는 '키보드 focus-within' 에만 건다. 터치 탭·마우스 클릭으로 버튼에 남은 포커스까지 사유로 잡으면
       모바일에서 조작 1회에 캐러셀이 무기한 정지한다 — perf-mobile-3 */
    var pointerFocus = false, pointerResetTimer = 0;
    var markPointer = function () {
      pointerFocus = true;
      clearTimeout(pointerResetTimer);
      pointerResetTimer = setTimeout(function () { pointerFocus = false; }, 500);
    };
    cleanups.push(on(document, 'pointerdown', markPointer, true));
    cleanups.push(on(document, 'touchstart', markPointer, { capture: true, passive: true }));
    cleanups.push(on(document, 'mousedown', markPointer, true));
    cleanups.push(on(document, 'keydown', function () { clearTimeout(pointerResetTimer); pointerFocus = false; }, true));
    var keyboardFocus = function (t) {
      if (t && t.matches) { try { return t.matches(':focus-visible'); } catch (e) { /* 미지원 */ } }
      return !pointerFocus;
    };
    cleanups.push(on(stageEl, 'focusin', function (e) { if (keyboardFocus(e.target)) pause('focus'); }));
    cleanups.push(on(stageEl, 'focusout', function (e) { if (!e.relatedTarget || !stageEl.contains(e.relatedTarget)) resume('focus'); }));
    cleanups.push(on(document, 'visibilitychange', function () { if (document.hidden) pause('hidden'); else resume('hidden'); }));

    /* ── init (§5-3) */
    var ssrIndex = sceneEls.findIndex(function (el) { return el.classList.contains('is-active'); });
    if (ssrIndex < 0) ssrIndex = 0;
    var startIndex = cfg.stage.initialIndex || 0;
    var hashM = /^#scene-(\d+)$/.exec(location.hash || '');
    var params = new URLSearchParams(location.search);
    var revKV = String(cfg.stage.reverseEntryParam).split('=');
    if (hashM && +hashM[1] >= 0 && +hashM[1] < N) {
      startIndex = +hashM[1];
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ }
    } else if (params.get(revKV[0]) === (revKV[1] || '')) {
      startIndex = norm(cfg.stage.reverseEntryIndex);
      dir = cfg.stage.reverseEntryDirection < 0 ? -1 : 1;
      params.delete(revKV[0]);
      var q = params.toString();
      try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* noop */ }
    }
    index = ssrIndex;
    stageEl.dataset.dir = String(dir);
    stageEl.dataset.wheel = wheelOn ? 'on' : 'off';
    stageEl.dataset.paused = 'false';
    initHint();
    /* 첫 프레임 페이드인 훅(포스터 → 영상). CSS 가 .stage__vid.is-playing 을 쓰지 않아도 무해하다 */
    slots.forEach(function (sl) {
      if (!sl.video) return;
      cleanups.push(on(sl.video, 'playing', function () { sl.video.classList.add('is-playing'); }));
      cleanups.push(on(sl.video, 'emptied', function () { sl.video.classList.remove('is-playing'); }));
    });
    /* 모바일 무영상 경로 해제 트리거(있을 때만 연결) */
    if (videoBtn) {
      videoBtn.setAttribute('aria-pressed', 'false');
      cleanups.push(on(videoBtn, 'click', function () {
        videoOptIn = !videoOptIn;
        videoBtn.setAttribute('aria-pressed', videoOptIn ? 'true' : 'false');
        swapVideo(index);
      }));
    }
    if (reducedMotion()) pause('rm');
    if (document.hidden) pause('hidden');   /* 백그라운드 탭에서 열린 경우 — fidelity-12 */
    if (startIndex !== ssrIndex) {
      goTo(startIndex, 'auto', true, true);
    } else {
      updatePager(index);
      swapVideo(index);
      restartSweep(index);
    }
    if (RM.addEventListener) RM.addEventListener('change', function () { if (reducedMotion()) pause('rm'); else resume('rm'); });
    syncPauseBtn();
    emit(stageEl, 'cs:ready', { index: index, dir: dir, paused: paused() });

    var api = {
      index: function () { return index; },
      dir: function () { return dir; },
      goTo: function (i, src) { hideHint(); goTo(i, src || 'user'); },
      /* 무대 밖 트리거(드롭다운 카드·모바일 메뉴·목차)에서 점프한 뒤 포커스를 장면 시작점으로 옮긴다 — a11y-live-1 */
      focusSceneStart: focusSceneStart,
      next: function (src) { hideHint(); next(src || 'user'); },
      prev: function (src) { hideHint(); prev(src || 'user'); },
      pause: pause,
      resume: resume,
      isPaused: paused,
      reasons: function () { return Array.from(reasons); },
      setWheel: function (v) { wheelOn = !!v; stageEl.dataset.wheel = wheelOn ? 'on' : 'off'; },
      enableVideo: function (v) {
        videoOptIn = v !== false;
        if (videoBtn) videoBtn.setAttribute('aria-pressed', videoOptIn ? 'true' : 'false');
        swapVideo(index);
      },
      destroy: function () {
        cleanups.forEach(function (f) { f(); }); cleanups = [];
        clearTimeout(preloadTimer); clearTimeout(preloadAutoTimer); clearTimeout(fallbackTimer); clearTimeout(wheelLockTimer); clearTimeout(wheelIdleTimer); clearTimeout(pointerResetTimer);
        segs.forEach(function (s) { s.classList.remove('is-sweeping'); });
        if (window.CSStage === api) window.CSStage = undefined;
      }
    };
    return api;
  }

  /* ════════════════════════════════════════════════ 헤더 드롭다운 · 버거 · 모바일 메뉴 (§5-6) */
  function initHeader(stage) {
    var header = qs('.site-header');
    if (!header) return { closeAll: function () {} };
    var items = qsa('.site-nav__item', header).map(function (li) {
      var btn = qs('button.site-nav__trigger', li);
      var panel = btn ? document.getElementById(btn.getAttribute('aria-controls')) : null;
      return btn && panel ? { li: li, btn: btn, panel: panel, timer: 0 } : null;
    }).filter(Boolean);
    var openItem = null;
    var lastPointerType = '';
    var openedAt = 0;
    var menuReasonOn = false;
    function syncMenuReason() {
      var anyOpen = !!openItem || mobileOpen;
      if (!stage) return;
      if (anyOpen && !menuReasonOn) { menuReasonOn = true; stage.pause('menu'); }
      else if (!anyOpen && menuReasonOn) { menuReasonOn = false; stage.resume('menu'); }
    }
    function openDD(it) {
      clearTimeout(it.timer);
      if (openItem && openItem !== it) closeDD(openItem, true);
      if (openItem === it) return;
      it.panel.hidden = false;
      it.btn.setAttribute('aria-expanded', 'true');
      it.li.classList.add('is-open');
      openItem = it;
      openedAt = Date.now();
      syncMenuReason();
    }
    function closeDD(it, keepReason) {
      clearTimeout(it.timer);
      if (openItem !== it) return;
      it.panel.hidden = true;
      it.btn.setAttribute('aria-expanded', 'false');
      it.li.classList.remove('is-open');
      openItem = null;
      if (!keepReason) syncMenuReason();
    }
    function closeAllDD() { if (openItem) closeDD(openItem); }
    items.forEach(function (it) {
      var hoverOpen = function (e) { if (e.pointerType && e.pointerType !== 'mouse') return; openDD(it); };
      var hoverClose = function (e) { if (e.pointerType && e.pointerType !== 'mouse') return; clearTimeout(it.timer); it.timer = setTimeout(function () { closeDD(it); }, 180); };
      if (window.PointerEvent) { on(it.li, 'pointerenter', hoverOpen); on(it.li, 'pointerleave', hoverClose); }
      else { on(it.li, 'mouseenter', hoverOpen); on(it.li, 'mouseleave', hoverClose); }
      /* disclosure 패턴: Tab 으로 지나가는 것만으로는 열리지 않는다(focus-open 제거 — a11y-2).
         열기 = mouse hover · click/Enter/Space 토글 · 닫기 = pointerleave 180ms · focusout · Esc · 바깥 click.
         마우스로 hover 해 이미 열린 트리거를 클릭했을 때 닫히지 않게 포인터 종류를 본다(craft-contract-8). */
      on(it.btn, 'pointerdown', function (e) { lastPointerType = e.pointerType || 'mouse'; });
      /* PointerEvent 미지원 분기(위 mouseenter/mouseleave)에서는 pointerdown 이 없어 lastPointerType 이
         영원히 빈 문자열이 된다 → 아래 byKeyboard 가 항상 참이 되어 hover 로 열린 패널을 클릭이 닫는다 */
      on(it.btn, 'mousedown', function () { if (!lastPointerType) lastPointerType = 'mouse'; });
      on(it.btn, 'click', function (e) {
        var byKeyboard = e.detail === 0 || !lastPointerType;
        /* hover 로 막 열린 직후의 클릭만 무시한다(한 동작에 열림→닫힘 방지 · craft-contract-8).
           시간 창을 두지 않으면 마우스 사용자가 트리거 클릭으로 패널을 영영 닫지 못한다(회귀) */
        var wasMouseHover = !byKeyboard && lastPointerType === 'mouse' && openItem === it && (Date.now() - openedAt) < 500;
        lastPointerType = '';
        if (wasMouseHover) return;
        if (openItem === it) closeDD(it); else openDD(it);
      });
      on(it.li, 'focusout', function (e) { if (!e.relatedTarget || !it.li.contains(e.relatedTarget)) closeDD(it); });
    });
    /* 바깥 클릭·탭으로 닫기. 모바일 메뉴는 body 스크롤을 잠그므로 닫는 경로가 X·Esc 뿐이면
       '왜 스크롤이 안 되는지' 단서가 없다 — 메뉴 밖(카드 영역) 탭도 닫기로 받는다 (a11y-16).
       버거·메뉴는 header 안이라 자기 토글과 겹치지 않는다 */
    on(document, 'click', function (e) {
      if (header.contains(e.target)) return;
      if (openItem) closeAllDD();
      if (mobileOpen) closeMenu(false);
    });

    /* 버거 · 모바일 메뉴 */
    var burger = qs('.site-header__burger', header);
    var menu = document.getElementById('mobile-menu');
    var mobileOpen = false;
    var focusables = function () { return qsa('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])', menu).filter(function (el) { return el.offsetParent !== null || el === document.activeElement; }); };
    function setBurger(open) {
      if (!burger) return;
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      var label = open ? burger.dataset.labelClose : burger.dataset.labelOpen;
      if (label) burger.setAttribute('aria-label', label);
      var io = qs('.site-header__burger-icon--open', burger), ic = qs('.site-header__burger-icon--close', burger);
      if (io) io.hidden = open; if (ic) ic.hidden = !open;
    }
    function openMenu() {
      if (!menu || mobileOpen) return;
      closeAllDD();
      menu.hidden = false; mobileOpen = true;
      document.body.classList.add('menu-open');
      setBurger(true);
      syncMenuReason();
      var f = focusables(); if (f.length) f[0].focus();
    }
    function closeMenu(returnFocus) {
      if (!menu || !mobileOpen) return;
      menu.hidden = true; mobileOpen = false;
      document.body.classList.remove('menu-open');
      setBurger(false);
      syncMenuReason();
      if (returnFocus !== false && burger) burger.focus();
    }
    if (burger && menu) {
      on(burger, 'click', function () { if (mobileOpen) closeMenu(); else openMenu(); });
      on(menu, 'keydown', function (e) {
        if (e.key !== 'Tab') return;
        var f = focusables(); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      var mq = window.matchMedia('(min-width:876px)');
      var onMq = function () { if (mq.matches && mobileOpen) closeMenu(false); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else window.addEventListener('resize', onMq);
    }
    on(document, 'keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (mobileOpen) { e.preventDefault(); closeMenu(true); return; }
      if (openItem) { e.preventDefault(); var b = openItem.btn; closeDD(openItem); b.focus(); }
    });
    return { closeAll: function () { closeAllDD(); closeMenu(false); }, isMenuOpen: function () { return mobileOpen; } };
  }

  /* ════════════════════════════════════════════════ 장면 점프 버튼(드롭다운 카드·모바일 메뉴·목차) */
  function initSceneJumps(stage, header) {
    on(document, 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-scene-index]') : null;
      if (!btn || btn.classList.contains('pager__seg')) return;
      var n = parseInt(btn.dataset.sceneIndex, 10);
      if (isNaN(n)) return;
      e.preventDefault();
      if (stage) {
        stage.goTo(n, 'user');
        header.closeAll();
        if (!window.matchMedia('(min-width:1200px)').matches) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
      } else {
        location.href = homeHref() + '#scene-' + n;
      }
    });
  }

  /* ════════════════════════════════════════════════ ScrollProgress · 탭 */
  /* 레이아웃 속성(width) 대신 transform 만 프레임당 1회 갱신 — CONTRACT §4-3 (perf-mobile-9) */
  function initScrollProgress() {
    var bar = qs('.scroll-progress');
    if (!bar) return;
    bar.style.width = '100%';
    bar.style.transformOrigin = 'left center';
    bar.style.transform = 'scaleX(0)';
    var queued = false;
    var paint = function () {
      queued = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.transform = 'scaleX(' + ratio + ')';
    };
    var update = function () { if (queued) return; queued = true; requestAnimationFrame(paint); };
    on(window, 'scroll', update, { passive: true });
    on(window, 'resize', update, { passive: true });
    paint();
  }
  function initTabs() {
    qsa('.tabs').forEach(function (tabs) {
      var links = qsa('a.tabs__tab', tabs);
      if (links.some(function (a) { return a.getAttribute('aria-current') === 'page'; })) return;
      var here = location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '') || '/';
      links.forEach(function (a) {
        var href = (a.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/index\.html$/, '').replace(/\/$/, '');
        if (href && (here === href || here.endsWith(href))) a.setAttribute('aria-current', 'page');
      });
    });
  }

  /* ════════════════════════════════════════════════ 폼 클라이언트 (§7-1 · §7-2) */
  /* 폴백 문구 = SCENES.json forms.*.errors 와 동기 (통합자가 대조). 정식 경로는 form[data-errors] JSON 또는 #form-data */
  var ERRORS_FALLBACK = {
    required: '이 항목을 채워 주세요.',
    email: '이메일 형식을 확인해 주세요.',
    phone: '숫자와 하이픈만 입력해 주세요.',
    consent: '동의가 필요한 항목입니다.',
    network: '전송이 되지 않았습니다. 잠시 후 다시 보내 주시거나 이메일로 보내 주세요.',
    bot: '확인 절차를 마친 뒤 다시 보내 주세요.'
  };
  var SUBMITTING_FALLBACK = '보내는 중';
  var ERROR_MAP = { validation: 'required', bot: 'bot', network: 'network', unavailable: 'network', too_large: 'network', rate_limited: 'network', method: 'network' };

  function initForms() {
    qsa('form.join-form').forEach(initForm);
  }
  function initForm(form) {
    var errors = ERRORS_FALLBACK;
    try {
      var raw = form.dataset.errors || (qs('#form-data') && qs('#form-data').textContent) || (qs('#join-form-data') && qs('#join-form-data').textContent);
      if (raw) { var parsed = JSON.parse(raw); errors = Object.assign({}, ERRORS_FALLBACK, parsed.errors || parsed); }
    } catch (e) { /* 폴백 유지 */ }
    var submittingLabel = form.dataset.submitting || SUBMITTING_FALLBACK;
    var formKey = form.dataset.form || 'affiliate';
    var card = form.closest('.form-card') || form.parentNode;
    var alertEl = qs('.join-form__alert', card) || qs('.join-form__alert');
    var successEl = qs('.join-form__success', card) || qs('.join-form__success');
    var submitBtn = qs('.join-form__submit', form) || qs('button[type="submit"]', form);
    var submitText = submitBtn ? submitBtn.textContent : '';
    var fields = qsa('.field', form).filter(function (f) { return !f.classList.contains('field--hp'); });
    var email_re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/, tel_re = /^[0-9-]+$/;

    /* 프리필 ?line= */
    try {
      var line = new URLSearchParams(location.search).get('line');
      if (line && /^[a-z]+$/.test(line)) {
        var cb = qs('input[type="checkbox"][name="line"][value="' + line + '"]', form);
        if (cb) cb.checked = true;
      }
    } catch (e) { /* noop */ }

    function inputsOf(field) { return qsa('input,select,textarea', field); }
    function errorEl(field) { return qs('.field__error', field); }
    function setError(field, key) {
      var el = errorEl(field);
      var msg = key ? (errors[key] || errors.required) : '';
      if (el) { el.textContent = msg; el.hidden = !key; }
      field.setAttribute('data-valid', key ? 'false' : 'true');
      inputsOf(field).forEach(function (inp) {
        if (key && field.dataset.type !== 'multiselect') inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
      });
      if (key && field.dataset.type === 'multiselect') { var fs = qs('fieldset', field); if (fs) fs.setAttribute('aria-invalid', 'true'); }
      else { var fs2 = qs('fieldset', field); if (fs2) fs2.removeAttribute('aria-invalid'); }
    }
    function validateField(field) {
      var type = field.dataset.type, ins = inputsOf(field);
      var required = ins.some(function (i) { return i.required; }) || field.dataset.required === 'true';
      var key = null;
      if (type === 'multiselect') {
        var checked = ins.filter(function (i) { return i.type === 'checkbox' && i.checked; });
        if (required && !checked.length) key = 'required';
      } else if (type === 'checkbox') {
        var c = ins[0]; if (c && c.required && !c.checked) key = 'consent';
      } else {
        var inp = ins[0]; if (!inp) return true;
        var v = (inp.value || '').trim();
        if (required && !v) key = 'required';
        else if (v && type === 'email' && ((inp.validity && inp.validity.typeMismatch) || !email_re.test(v))) key = 'email';
        else if (v && type === 'tel' && !tel_re.test(v)) key = 'phone';
      }
      setError(field, key);
      return key;   /* null = 통과, 그 외 = 오류 키 */
    }
    fields.forEach(function (field) {
      inputsOf(field).forEach(function (inp) {
        on(inp, 'blur', function () { validateField(field); });
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT') on(inp, 'change', function () { validateField(field); });
        else on(inp, 'input', function () { if (field.getAttribute('data-valid') === 'false') validateField(field); });
      });
    });

    /* role=alert 재공지 보장: 같은 문구를 다시 넣어도 SR 이 읽도록 비웠다가 다음 프레임에 채운다 */
    function showAlert(msg) {
      if (!alertEl) return;
      alertEl.hidden = false;
      if (alertEl.textContent === msg) { alertEl.textContent = ''; requestAnimationFrame(function () { alertEl.textContent = msg; }); }
      else alertEl.textContent = msg;
    }
    function hideAlert() { if (alertEl) { alertEl.hidden = true; alertEl.textContent = ''; } }
    function focusAlert() {
      if (!alertEl) return;
      if (!alertEl.hasAttribute('tabindex')) alertEl.setAttribute('tabindex', '-1');
      try { alertEl.focus({ preventScroll: false }); } catch (e) { alertEl.focus(); }
    }
    /* disabled 대신 aria-disabled + aria-busy — disabled 는 포커스를 body 로 떨어뜨려 오류 복귀 시 위치를 잃는다(a11y-13) */
    function setState(state, error) {
      form.setAttribute('data-state', state);
      if (state === 'error' && error) form.setAttribute('data-error', error); else form.removeAttribute('data-error');
      var busy = state === 'submitting';
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
      if (submitBtn) {
        submitBtn.disabled = false;
        if (busy) { submitBtn.setAttribute('aria-disabled', 'true'); submitBtn.textContent = submittingLabel; }
        else { submitBtn.removeAttribute('aria-disabled'); submitBtn.textContent = submitText; }
      }
      emit(form, 'cs:formstate', error ? { state: state, error: error } : { state: state });
    }
    if (submitBtn) on(submitBtn, 'click', function (e) { if (submitBtn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopPropagation(); } }, true);
    function collect() {
      var out = {}, lineVals = [];
      fields.forEach(function (field) {
        var name = field.dataset.name, type = field.dataset.type;
        if (!name || name === 'consent') return;
        if (type === 'multiselect') { qsa('input[type="checkbox"]', field).forEach(function (c) { if (c.checked) lineVals.push(c.value); }); out[name] = lineVals; return; }
        var inp = qs('input,select,textarea', field); if (inp) out[name] = (inp.value || '').trim();
      });
      var consent = qs('input[name="consent"]', form);
      var hp = qs('input[name="website"]', form);
      var payload = { form: formKey, fields: out, consent: !!(consent && consent.checked), website: hp ? hp.value : '', page: location.pathname + location.search, ts: new Date().toISOString() };
      if (qs('.cf-turnstile', form) && window.turnstile && window.turnstile.getResponse) {
        try { payload.turnstileToken = window.turnstile.getResponse() || ''; } catch (e) { payload.turnstileToken = ''; }
      }
      return payload;
    }
    function failForm(errorKind, serverFields) {
      setState('error', errorKind);
      var firstBad = null, firstKey = null;
      if (errorKind === 'validation' && serverFields) {
        Object.keys(serverFields).forEach(function (name) {
          var f = fields.find(function (x) { return x.dataset.name === name; });
          if (f) { setError(f, serverFields[name]); if (!firstBad) { firstBad = f; firstKey = serverFields[name]; } }
        });
      }
      /* 서버가 돌려준 실제 사유를 말한다. ERROR_MAP.validation='required' 로 고정하면 이메일 형식
         오류에도 「이 항목을 채워 주세요」가 뜬다 — 클라이언트 검증 경로와 같은 규칙으로 맞춘다(a11y-13) */
      showAlert((firstKey && errors[firstKey]) || errors[ERROR_MAP[errorKind] || 'network']);
      /* 전송 후 오류로 돌아오면 포커스가 body 에 남는다 — 첫 오류 필드, 없으면 알림으로 옮긴다 */
      var inp = firstBad ? qs('input,select,textarea', firstBad) : null;
      if (inp) inp.focus(); else focusAlert();
    }
    function succeed() {
      setState('success');
      hideAlert();
      form.hidden = true;
      if (successEl) { successEl.hidden = false; if (!successEl.hasAttribute('tabindex')) successEl.setAttribute('tabindex', '-1'); successEl.focus(); }
    }

    on(form, 'submit', function (e) {
      e.preventDefault();
      if (form.getAttribute('data-state') === 'submitting') return;
      hideAlert();
      var firstBad = null, firstKey = null;
      fields.forEach(function (f) { var k = validateField(f); if (k && !firstBad) { firstBad = f; firstKey = k; } });
      if (firstBad) {
        setState('error', 'validation');
        /* 첫 오류의 실제 사유를 말한다 — 형식 오류에 「채워 주세요」라고 하지 않는다(a11y-13) */
        showAlert(errors[firstKey] || errors.required);
        var inp = qs('input,select,textarea', firstBad); if (inp) inp.focus();
        return;
      }
      if (location.protocol === 'file:' || !window.fetch) { failForm('network'); return; }
      setState('submitting');
      var payload = collect();
      fetch(form.getAttribute('action') || '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' })
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'network' }; }); })
        .then(function (json) {
          if (json && json.ok) { succeed(); return; }
          var kind = json && typeof json.error === 'string' ? json.error : 'network';
          failForm(kind, json && json.fields);
        })
        .catch(function () { failForm('network'); });
    });
  }

  /* ════════════════════════════════════════════════ 부트 */
  ready(function () {
    var stageEl = qs('.stage');
    var stage = stageEl ? createStage(stageEl) : null;
    window.CSStage = stage || undefined;
    var header = initHeader(stage);
    initSceneJumps(stage, header);
    initScrollProgress();
    initTabs();
    initForms();
  });
})();
