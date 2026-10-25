
import { Speaker } from '../audio/index.ts';
import {
  type CategoryId,
  CONFIG,
  conceptText,
  type FaceFrame,
  findWord,
  type Point,
  sidePanelWidthCss,
} from '../core/index.ts';
import {
  fitPointer,
  FacePointer,
  GazeCursor,
  type PointerFrame,
  RAD_TO_DEG,
  signalFor,
} from '../gaze/index.ts';
import { fallbackSentences, LlmClient } from '../nlp/index.ts';
import {
  AccuracyCheckScreen,
  Board,
  CalibrationScreen,
  DwellController,
  HistoryPanel,
  LandingScreen,
  SetupScreen,
  solveRingLayout,
  toast,
} from '../ui/index.ts';
import { bothEyesClosed, FaceTracker, LandmarkOverlay } from '../vision/index.ts';

type Phase = 'landing' | 'setup' | 'calibrate' | 'accuracy' | 'board';

export class App {
  private mount: HTMLElement;
  private phase: Phase = 'landing';

  private tracker = new FaceTracker();
  private overlay = new LandmarkOverlay(this.tracker.video);
  private pointer = new FacePointer(() => this.pointerFrame());
  private cursor = new GazeCursor();
  private dwell = new DwellController();
  private speaker = new Speaker();
  private llm = new LlmClient();
  // not shown on the board anymore, still feeds recent turns to the prompt.
  private history = new HistoryPanel();

  private board: Board;
  private calibration = new CalibrationScreen();
  private accuracy = new AccuracyCheckScreen();

  private concepts: string[] = [];
  private composeTimer = 0;
  /** true while a dwell ring is visibly filling. see `schedulecompose`. */
  private dwellCommitting = false;
  private generating = false;
  private candidates: string[] = [];

  private mouseMode = false;
  private mousePoint: Point | null = null;

  private facePreload: Promise<void> | null = null;
  private screenOff: (() => void) | null = null;

  private lastFaceAt = -Infinity;
  private faceLostSince: number | null = null;
  private faceLostToasted = false;

  constructor(mount: HTMLElement) {
    this.mount = mount;

    this.board = new Board({
      onWord: (id) => this.addConcept(id),
      onCategory: (id) => this.openCategory(id),
      onShowCategories: () => this.showCategories(),
      onRemoveConcept: (i) => this.removeConcept(i),
      onClear: () => this.clearConcepts(),
      onSpeakRaw: () => this.speakRaw(),
      onCandidate: (i) => this.chooseCandidate(i),
      onBack: () => this.backToConcepts(),
    });
    this.board.onTargetsChanged(() => this.syncTargets());
    // the camera panel invites the gaze but is not a tile, so it selects nothing.
    this.dwell.setExclusions(() => {
      if (!this.overlay.isVisible()) return [];
      const r = this.overlay.root.getBoundingClientRect();
      return r.width > 0 ? [r] : [];
    });

    this.dwell.onFire((id, rect) => this.onDwellFire(id, rect));
    this.dwell.onCancel(() => {
      this.cursor.setState('cancelled');
      this.cancelCompose();
      // the long blink is "start over": drops the picked words and goes home
      // to the category ring from wherever the user is.
      if (this.phase !== 'board') return;
      const had = this.concepts.length > 0;
      this.resetRound();
      toast(had ? 'Words cleared' : 'Selection cancelled', 'warn', 1400);
    });
    this.dwell.onState((s) => {
      this.dwellCommitting = s === 'committing';
      this.cursor.setState(
        s === 'committing' ? 'committing' : s === 'idle' || s === 'cooldown' ? 'idle' : 'hover',
      );
    });

    this.tracker.onFrame((f) => this.onFrame(f));

    window.addEventListener('resize', () => {
      requestAnimationFrame(() => {
        this.dwell.setRing(this.board.ringGeometry());
        this.dwell.refreshRects();
      });
      // tiles animate to their new slots over 200ms, so measure again after.
      setTimeout(() => this.dwell.refreshRects(), 300);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('mousemove', (e) => {
      this.mousePoint = { x: e.clientX, y: e.clientY };
    });
  }

  start(): void {
    this.preload();
    this.showLanding();
  }

  private preload(): void {
    this.llm.start();
    this.facePreload = this.tracker.initLandmarker();
    this.facePreload.catch(() => {});
  }

  private async ensureLandmarker(onStatus: (s: string) => void): Promise<void> {
    if (this.facePreload) {
      try {
        await this.facePreload;
        return;
      } catch {
        this.facePreload = null;
      }
    }
    this.facePreload = this.tracker.initLandmarker(onStatus);
    await this.facePreload;
  }

  private setScreen(el: HTMLElement): void {
    this.screenOff?.();
    this.screenOff = null;
    this.mount.innerHTML = '';
    this.mount.appendChild(el);
  }

  private showLanding(): void {
    this.phase = 'landing';
    this.cursor.setVisible(false);
    this.setScreen(new LandingScreen(() => void this.runSetup()).root);
  }

  private async runSetup(): Promise<void> {
    this.phase = 'setup';
    const setup = new SetupScreen([
      { key: 'camera', label: 'Camera access' },
      { key: 'face', label: 'Face tracking model (3.7 MB, bundled)' },
      { key: 'llm', label: 'Language model (~570 MB, downloads once then cached)' },
    ]);
    this.setScreen(setup.root);
    setup.mountOverlay(this.overlay.root);

    this.llm.start();
    this.screenOff = this.llm.onState((s) => {
      if (this.phase !== 'setup') return;
      if (s.kind === 'loading') setup.set('llm', s.detail, s.pct, 'normal');
      else if (s.kind === 'ready') {
        // labelled the same way the template-fallback path is: if the model
        // running is not the one that was advertised (smaller, because this
        // browser's storage couldn't reliably cache the big one), say so.
        const note = s.downsized ? ' - smaller model, limited browser storage' : '';
        setup.set('llm', `ready on ${s.backend} (${(s.loadMs / 1000).toFixed(1)}s)${note}`, 100, 'ok');
      } else if (s.kind === 'failed') {
        setup.set('llm', 'unavailable - using templates', 100, 'warn');
      }
    });

    try {
      setup.set('camera', 'requesting...', 20);
      await this.tracker.startCamera();
      setup.set('camera', 'live', 100, 'ok');
    } catch (err) {
      setup.set('camera', 'unavailable', 100, 'error');
      setup.showError(err instanceof Error ? err.message : String(err));
      setup.setActions([
        { label: 'Retry', primary: true, onClick: () => void this.runSetup() },
        { label: 'Continue with mouse', onClick: () => this.startMouseMode() },
      ]);
      return;
    }

    try {
      setup.set('face', 'loading...', 30);
      await this.ensureLandmarker((s) => setup.set('face', s, 60));
      setup.set('face', `ready (${this.tracker.delegate})`, 100, 'ok');
    } catch (err) {
      setup.set('face', 'failed', 100, 'error');
      setup.showError(`Face tracking failed to start: ${String(err)}`);
      setup.setActions([
        { label: 'Retry', primary: true, onClick: () => void this.runSetup() },
        { label: 'Continue with mouse', onClick: () => this.startMouseMode() },
      ]);
      return;
    }

    this.tracker.start();
    this.overlay.setVisible(true);

    setup.setActions([
      { label: 'Calibrate', primary: true, onClick: () => this.startCalibration() },
      { label: 'Skip - use mouse', onClick: () => this.startMouseMode() },
    ]);
  }

  private startMouseMode(): void {
    this.mouseMode = true;
    // no camera means nothing to show, so skip the empty panel.
    this.overlay.setVisible(CONFIG.ui.debugOverlayDefault && this.tracker.video.readyState >= 2);
    toast('Mouse mode: the cursor follows your pointer', 'info', 3000);
    this.showBoard();
  }

  /* ------------------------------------------------------------- calibration */

  private startCalibration(): void {
    if (this.mouseMode) {
      toast('Calibration needs the camera', 'warn');
      return;
    }
    if (!this.hasRecentFace()) {
      toast('No face detected - center your face in the camera and try again', 'warn', 3200);
      return;
    }
    this.phase = 'calibrate';
    this.cursor.setVisible(false);
    this.dwell.enabled = false;
    this.setScreen(this.calibration.root);
    this.overlay.setVisible(true);
    this.calibration.mountOverlay(this.overlay.root);

    void this.calibration.start().then((result) => {
      if (!result.dots.length) {
        toast('Calibration cancelled', 'warn');
        if (this.pointer.calibrated) this.showBoard();
        else void this.runSetup();
        return;
      }
      const fit = fitPointer(result.dots);
      const r4 = (v: number) => v.toFixed(4);
      const r3 = (v: number) => v.toFixed(3);
      const sg = (v: number) => (v > 0 ? '+1' : '-1');
      if (fit.diag) {
        const { config: c, best: b, used } = fit.diag.eyeFit;
        const u = used === 'measured' ? b : c;
        console.info(
          `[gaze] calib eyeFit config(g=${c.gain},s=${sg(c.sign)}) resid=${r3(c.residual)} ` +
            `best(g=${b.gain},s=${sg(b.sign)}) resid=${r3(b.residual)} ` +
            `using=(g=${u.gain},s=${sg(u.sign)}) (${used})`,
        );
        const d = fit.diag;
        console.info(
          `[gaze] calib split x head=${r4(d.split.headX)} eye=${r4(d.split.eyeX)} | ` +
            `y head=${r4(d.split.headY)} eye=${r4(d.split.eyeY)}`,
        );
      }
      if (!fit.ok) {
        console.info(`[gaze] calib rejected ${fit.reason}: ${fit.message} (${result.elapsedMs}ms)`);
        toast(fit.message, 'warn', 3200);
        // a camera with no transform matrix won't fix itself on a retry.
        if (fit.reason !== 'noHeadPose' && this.hasRecentFace()) this.startCalibration();
        else if (this.pointer.calibrated) this.showBoard();
        else void this.runSetup();
        return;
      }
      const m = fit.model;
      const deg = (v: number) => (v * RAD_TO_DEG).toFixed(1);
      // A maps rad to ring radii, so 1 / |column| is roughly the head + eye
      // turn (deg) from centre to the ring edge on that axis.
      const reach = (a: number, b: number) => deg(1 / Math.hypot(a, b));
      console.info(
        `[gaze] calib zero=${r4(m.zero.x)},${r4(m.zero.y)}rad ` +
          `A=[${m.A.map((v) => v.toFixed(2)).join(',')}] ` +
          `reach~${reach(m.A[0], m.A[2])},${reach(m.A[1], m.A[3])}deg ` +
          `Qu=[${m.Q.u.map(r3).join(',')}] Qv=[${m.Q.v.map(r3).join(',')}] ` +
          `eye=g${m.eyeGain},s${sg(m.eyeSign)} ` +
          `resid=${r3(m.residualFrac)} (affine ${r3(fit.diag.affineResidualFrac)}) ring radii ` +
          `frames=${fit.diag.framesPerDot.join(',')} ` +
          `noPose=${Math.round(fit.diag.missingPoseFrac * 100)}% ` +
          `arrival=${result.arrivalWaitMs.join(',')}ms elapsed=${result.elapsedMs}ms`,
      );
      this.pointer.setModel(m);
      toast('Ready - look at a word and hold', 'good', 2600);
      this.overlay.setVisible(CONFIG.ui.debugOverlayDefault);
      this.showBoard();
    });
  }

  /**
   * what the pointer maps onto: the board's ring when it is up, else the ring
   * the board would solve for this window, centred (sentence list, accuracy).
   */
  private pointerFrame(): PointerFrame {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const g = this.phase === 'board' ? this.board.ringGeometry() : null;
    if (g) return { cx: g.cx, cy: g.cy, rx: g.rx, ry: g.ry, vw, vh, ring: true };
    const { rx, ry } = solveRingLayout(vw, vh);
    return { cx: vw / 2, cy: vh / 2, rx, ry, vw, vh, ring: false };
  }

  /* ------------------------------------------------------------------- board */

  private showBoard(): void {
    this.phase = 'board';
    this.dwell.enabled = true;

    const wrap = document.createElement('div');
    wrap.className = 'screen';

    // holds the camera / landmark view (D key toggles it). same clamp
    // `layoutring` reserves so it never sits over a tile.
    const right = document.createElement('div');
    right.className = 'pointer-events-auto absolute top-6 right-6 z-20 flex flex-col gap-3';
    right.style.width = sidePanelWidthCss();
    right.appendChild(this.overlay.root);

    wrap.append(this.board.root, right);
    this.setScreen(wrap);

    this.cursor.setVisible(true);
    // wait for entry anims b4 measuring hit boxes.
    requestAnimationFrame(() => this.syncTargets());
    setTimeout(() => this.dwell.refreshRects(), 500);

    if (this.mouseMode) this.startMouseLoop();
  }

  private syncTargets(): void {
    if (this.phase !== 'board') return;
    this.dwell.setTargets(this.board.targets(), this.board.ringGeometry());
  }

  private startMouseLoop(): void {
    const loop = () => {
      if (!this.mouseMode) return;
      requestAnimationFrame(loop);
      const t = performance.now();
      if (this.mousePoint && this.phase === 'board') {
        this.cursor.move(this.mousePoint);
        this.dwell.update(this.mousePoint, false, t);
      }
    };
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------- frame input */

  private hasRecentFace(): boolean {
    return performance.now() - this.lastFaceAt < CONFIG.vision.faceLostGraceMs;
  }

  private onFrame(frame: FaceFrame | null): void {
    this.overlay.draw(frame);
    const t = frame?.t ?? performance.now();
    if (frame) this.lastFaceAt = t;

    if (this.phase === 'calibrate') {
      this.calibration.onFrame(frame, t);
      return;
    }
    if (this.phase === 'accuracy') {
      // same path the board runs, minus dwell: closed lids keep the last point.
      const open = !!frame && !bothEyesClosed(frame, CONFIG.blink.closedThreshold);
      if (open) this.pointer.update(frame);
      this.accuracy.onFrame(
        frame ? this.pointer.point : null,
        frame ? this.pointer.rawPoint : null,
        open ? this.pointer.signalNow : null,
        t,
      );
      return;
    }
    if (this.phase !== 'board' || this.mouseMode) return;

    if (!frame) {
      // face lost: freeze the cursor where it was rather than snapping it to a
      // stale prediction, and let the dwell machine idle out. if it stays lost
      // past the grace window, say so - a frozen cursor with no explanation
      // reads as the board being broken, not as tracking being paused.
      if (this.faceLostSince === null) this.faceLostSince = t;
      else if (!this.faceLostToasted && t - this.faceLostSince >= CONFIG.vision.faceLostGraceMs) {
        this.faceLostToasted = true;
        toast('No face detected - selection is paused until tracking returns', 'warn', 3200);
      }
      this.dwell.update(null, false, t);
      return;
    }
    this.faceLostSince = null;
    this.faceLostToasted = false;

    const closed = bothEyesClosed(frame, CONFIG.blink.closedThreshold);
    // only feed the pointer while the eyes are open - closed lids make the
    // iris landmarks meaningless and would yank the cursor across the screen.
    const point = closed ? this.pointer.point : this.pointer.update(frame);
    if (point) this.cursor.move(point);
    this.dwell.update(point, closed, t);
  }

  /* ---------------------------------------------------------------- selection */

  private onDwellFire(id: string, rect: DOMRect): void {
    this.board.flash(id);

    if (id.startsWith('word:')) {
      this.addConcept(id.slice(5));
      this.feedImplicitCalibration(id, rect);
    } else if (id.startsWith('cat:')) {
      this.feedImplicitCalibration(id, rect);
      this.openCategory(id.slice(4) as CategoryId);
    } else if (id === 'action:categories') {
      this.feedImplicitCalibration(id, rect);
      this.showCategories();
    }
    else if (id === 'action:clear') this.clearConcepts();
    else if (id === 'action:speak') this.speakRaw();
    else if (id === 'action:back') this.backToConcepts();
    else if (id.startsWith('cand:')) this.chooseCandidate(Number(id.slice(5)));
  }

  /**
   * a confirmed gaze fire is evidence of where the eyes were, so it nudges
   * the pointer's zero. gaze-confirmed only: a mouse click on the same tile goes
   * through board's callbacks, not this dwell-fire path, precisely because a
   * click tells us nothing about where the eyes actually were.
   */
  private feedImplicitCalibration(id: string, rect: DOMRect): void {
    if (this.mouseMode) return;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const r = this.pointer.recordImplicitCalibration({ x, y });
    if (!r) return;
    const deg = (v: number) => (v * RAD_TO_DEG).toFixed(2);
    console.info(
      `[gaze] fire ${id} at ${Math.round(x)},${Math.round(y)}: ` +
        `err ${deg(r.error.x)},${deg(r.error.y)}deg zero step ${deg(r.step.x)},${deg(r.step.y)}deg`,
    );
  }

  private addConcept(wordId: string): void {
    if (this.board.mode !== 'concepts') return;
    const word = findWord(wordId);
    if (!word) return;
    const concept = conceptText(word.label);

    // same word twice in a row is almost always a double-fire, not intent.
    if (this.concepts.at(-1) === concept) return;

    this.concepts.push(concept);
    this.board.setConcepts(this.concepts);

    // speak the word immediately. see config.llm.speakconceptonselect - for a
    // single-word message this is the entire utterance, and it must not wait on
    // the compose window. it is deliberately not logged to the conversation
    // history: history is what was *said as a message*, and the words are
    // already visible in the concept strip.
    if (CONFIG.llm.speakConceptOnSelect) this.speaker.speak(word.label);

    if (this.concepts.length >= CONFIG.llm.maxConcepts) {
      this.cancelCompose();
      void this.compose();
      return;
    }
    this.scheduleCompose();
  }

  /**
   * open a category's ring. picked words carry over untouched - a message can
   * mix words from several categories - and moving between rings counts as
   * still composing, so it restarts the compose window just like picking a
   * word does. otherwise the 2.4 s window would run out on the way from one
   * category to the next.
   */
  private openCategory(id: CategoryId): void {
    if (this.board.mode !== 'concepts' || this.board.currentCategory === id) return;
    this.dwell.requireExit();
    this.board.openCategory(id);
    if (this.concepts.length) this.scheduleCompose();
  }

  private showCategories(): void {
    if (this.board.mode !== 'concepts' || this.board.currentCategory === null) return;
    this.dwell.requireExit();
    this.board.showCategories();
    if (this.concepts.length) this.scheduleCompose();
  }

  private scheduleCompose(): void {
    this.cancelCompose();
    if (this.concepts.length < CONFIG.llm.minConceptsToGenerate) return;
    this.board.startComposeCountdown(CONFIG.llm.composeGraceMs);
    this.composeTimer = window.setTimeout(() => {
      this.composeTimer = 0;
      // never compose out from under a ring that is visibly filling - the user
      // is mid-selection (often "back to categories" on the way to another
      // word). give them a fresh window instead; the fire itself re-arms it.
      if (this.dwellCommitting) {
        this.scheduleCompose();
        return;
      }
      void this.compose();
    }, CONFIG.llm.composeGraceMs);
  }

  private cancelCompose(): void {
    if (this.composeTimer) clearTimeout(this.composeTimer);
    this.composeTimer = 0;
    this.board.cancelComposeCountdown();
  }

  private async compose(): Promise<void> {
    if (this.generating || !this.concepts.length) return;
    this.generating = true;

    const concepts = [...this.concepts];
    this.board.showThinking(concepts);
    this.syncTargets();

    let suggestion;
    try {
      suggestion = await this.llm.suggest(concepts, this.history.recent(CONFIG.llm.historyTurns));
    } catch (err) {
      // suggest() is written not to reject, but a board that dies here would
      // take the user's only way to talk with it, so this stays.
      console.error('[app] suggest threw', err);
      suggestion = {
        sentences: fallbackSentences(concepts, CONFIG.llm.candidateCount),
        source: 'fallback' as const,
        ms: 0,
      };
    } finally {
      this.generating = false;
    }

    // the user may have hit back or clear while the model was working.
    if (this.board.mode !== 'candidates') return;

    // the bare words go last: the model's sentences are the point of the
    // feature, but the literal option must always be reachable in case the
    // generated ones miss what the user meant.
    this.candidates = [...suggestion.sentences];
    let plainIndex = -1;
    if (CONFIG.llm.plainWordsCandidate) {
      const plain = plainPhrase(concepts);
      // skip it if the model already produced effectively the same string.
      const dup = this.candidates.some((s) => normalise(s) === normalise(plain));
      if (!dup) plainIndex = this.candidates.push(plain) - 1;
    }
    this.board.showCandidates(this.candidates, plainIndex);
    this.syncTargets();
  }

  private chooseCandidate(index: number): void {
    const text = this.candidates[index];
    if (!text) return;
    this.say(text, [...this.concepts]);
    this.resetRound(text);
  }

  private speakRaw(): void {
    if (!this.concepts.length) {
      toast('Pick a word first', 'warn', 1600);
      return;
    }
    const text = plainPhrase(this.concepts);
    this.say(text, [...this.concepts]);
    this.resetRound(text);
  }

  private say(text: string, concepts: string[]): void {
    this.speaker.speak(text);
    // speak() is silent and throws nothing when the browser has no voice
    // installed, so without this the history would claim things were said out
    // loud that nobody nearby heard.
    if (!this.speaker.available) {
      toast('No speech voice on this system - nothing was spoken aloud', 'warn', 4000);
    }
    this.history.add({ text, concepts, at: Date.now() });
  }

  private resetRound(spoken?: string): void {
    this.concepts = [];
    this.cancelCompose();
    this.board.setConcepts(this.concepts);
    this.board.showConcepts();
    // a finished or cleared message starts the next one from the top.
    this.board.showCategories();
    this.syncTargets();
    // hold the sentence for a beat before the board empties, so a round ends on
    // what the user achieved rather than on an empty prompt to start again.
    if (spoken) this.board.showSpoken(spoken, CONFIG.ui.spokenHoldMs);
  }

  private removeConcept(index: number): void {
    const removed = this.concepts[index];
    if (removed === undefined) return;
    this.concepts.splice(index, 1);
    this.board.setConcepts(this.concepts);
    this.syncTargets();
    toast(`Removed "${removed}"`, 'info', 1400);
    // re-arm rather than cancel: the user is still composing, they just took a
    // word back. with nothing left there is nothing to compose from.
    if (this.concepts.length) this.scheduleCompose();
    else this.cancelCompose();
  }

  private clearConcepts(): void {
    if (!this.concepts.length && this.board.mode === 'concepts') {
      toast('Nothing to clear', 'info', 1400);
      return;
    }
    this.resetRound();
    toast('Cleared', 'info', 1200);
  }

  private backToConcepts(): void {
    // deliberately does not re-arm the compose timer: back means "let me keep
    // picking", and rescheduling here would bounce the user straight back to
    // the candidate list a moment later. adding the next word re-arms it.
    this.cancelCompose();
    this.board.showConcepts();
    this.board.setConcepts(this.concepts);
    this.syncTargets();
  }

  /* ---------------------------------------------------------- accuracy check */

  /** key `a`: ring spots + centre, angular and px error, sector picked. no fitting. */
  private startAccuracyCheck(): void {
    if (this.phase !== 'board') return;
    if (this.mouseMode || !this.pointer.calibrated) {
      toast('Accuracy check needs a gaze calibration first', 'warn', 2400);
      return;
    }
    if (!this.hasRecentFace()) {
      toast('No face detected - center your face in the camera and try again', 'warn', 3200);
      return;
    }
    this.phase = 'accuracy';
    this.dwell.enabled = false;
    this.dwell.reset();
    // the cursor would be looked at instead of the dot and bias the numbers.
    this.cursor.setVisible(false);
    this.cancelCompose();
    this.setScreen(this.accuracy.root);

    const need = (p: Point) =>
      this.pointer.model ? signalFor(this.pointer.model, p, this.pointerFrame()) : null;
    void this.accuracy.start(need).then((r) => {
      if (r.dots.length) {
        console.info(
          `[gaze] accuracy check: mean ${r.meanDeg.toFixed(1)}deg ${r.meanPx.toFixed(1)}px ` +
            `worst ${r.worstDeg.toFixed(1)}deg over ${r.dots.length} dots` +
            (r.cancelled ? ' (stopped early)' : ''),
        );
        // plain lines, not console.table: table rows don't survive log capture.
        const sec = (v: number | null) => (v === null ? 'centre' : String(v));
        r.dots.forEach((d, i) => {
          console.info(
            `[gaze] dot ${i + 1} at ${Math.round(d.target.x)},${Math.round(d.target.y)}: ` +
              `error ${d.errorDeg.toFixed(1)}deg ${d.errorPx.toFixed(1)}px ` +
              `sector ${sec(d.sector)}/${sec(d.wantSector)}`,
          );
        });
        const hits = r.dots.filter((d) => d.sector === d.wantSector).length;
        toast(
          `Accuracy: mean ${r.meanDeg.toFixed(1)} deg (${Math.round(r.meanPx)}px), ` +
            `right tile ${hits}/${r.dots.length}` +
            (r.cancelled ? ' (partial)' : ''),
          hits === r.dots.length ? 'good' : 'warn',
          4200,
        );
      } else {
        toast('Accuracy check stopped', 'info', 1600);
      }
      this.showBoard();
    });
  }

  /* ---------------------------------------------------------------- controls */

  // caregiver-only keys, nothing on screen for them. there is one cursor
  // (head + eyes), so there is no mode to switch.
  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key.toLowerCase()) {
      case 'd':
        this.overlay.setVisible(!this.overlay.isVisible());
        this.dwell.refreshRects();
        break;
      case 'c':
        if (this.phase === 'board') this.startCalibration();
        break;
      case 'a':
        this.startAccuracyCheck();
        break;
      case 's':
        this.speaker.stop();
        toast('Speech stopped', 'info', 1400);
        break;
      default:
        break;
    }
  }
}

function plainPhrase(concepts: string[]): string {
  const joined = concepts.join(' ').trim();
  if (!joined) return '';
  return `${joined[0]!.toUpperCase()}${joined.slice(1)}.`;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}
