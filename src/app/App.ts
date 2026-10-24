
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
import { GazeCursor, GazeEstimator } from '../gaze/index.ts';
import { fallbackSentences, LlmClient } from '../nlp/index.ts';
import {
  Board,
  CalibrationScreen,
  DwellController,
  HistoryPanel,
  LandingScreen,
  SetupScreen,
  toast,
} from '../ui/index.ts';
import { bothEyesClosed, FaceTracker, LandmarkOverlay } from '../vision/index.ts';

type Phase = 'landing' | 'setup' | 'calibrate' | 'board';

export class App {
  private mount: HTMLElement;
  private phase: Phase = 'landing';

  private tracker = new FaceTracker();
  private overlay = new LandmarkOverlay(this.tracker.video);
  private estimator = new GazeEstimator();
  private cursor = new GazeCursor();
  private dwell = new DwellController();
  private speaker = new Speaker();
  private llm = new LlmClient();
  // not shown on the board anymore, still feeds recent turns to the prompt.
  private history = new HistoryPanel();

  private board: Board;
  private calibration = new CalibrationScreen();

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

    this.dwell.onFire((id, rect) => this.onDwellFire(id, rect));
    this.dwell.onCancel(() => {
      toast('Selection cancelled', 'warn', 1400);
      this.cursor.setState('cancelled');
      this.cancelCompose();
    });
    this.dwell.onState((s) => {
      this.dwellCommitting = s === 'committing';
      this.cursor.setState(
        s === 'committing' ? 'committing' : s === 'idle' || s === 'cooldown' ? 'idle' : 'hover',
      );
    });

    this.tracker.onFrame((f) => this.onFrame(f));

    window.addEventListener('resize', () => {
      requestAnimationFrame(() => this.dwell.refreshRects());
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
      if (!result.samples.length) {
        toast('Calibration cancelled', 'warn');
        if (this.estimator.calibrated) this.showBoard();
        else void this.runSetup();
        return;
      }
      try {
        const model = this.estimator.fit(result.samples);
        // cverrorpx is the held-out error, so it is directly comparable to the
        // tile size (~84-140 px). above roughly a tile radius the cursor will
        // not reliably land where the user is looking, and telling them to
        // redo it beats letting them fight a bad fit.
        const px = Math.round(model.cvErrorPx);
        const badFit = px > 120;
        // the sway pass is the only source of head-pose variance. if the user
        // sat still through it there is nothing to fit the compensation terms
        // from, head mode has no vertical axis, and iris mode will drift the
        // moment they shift position. that is worth saying out loud, because
        // the fit itself will look perfectly healthy.
        const { yaw, pitch } = result.headSpread;
        const noSway = yaw < 0.12 || pitch < 0.08;
        // a high outlier fraction (see gaze/ridge.ts's huber pass) means a lot
        // of frames disagreed sharply with the rest of the capture - a shaky
        // camera, bad lighting, or someone walking through frame - which is a
        // more useful thing to tell the user than just "the fit is loose".
        const noisy = model.outlierFrac > 0.18;

        if (result.weakPoints.length) {
          toast(`${result.weakPoints.length} point(s) had weak tracking - consider redoing`, 'warn', 3600);
        } else if (noisy) {
          toast(
            `Calibrated (${px}px), but tracking was unsteady for ${Math.round(model.outlierFrac * 100)}% ` +
              `of it - steadier lighting or holding still helps more than redoing.`,
            'warn',
            4400,
          );
        } else if (badFit) {
          toast(`Calibrated but loose (${px}px). Press C to redo.`, 'warn', 4200);
        } else if (noSway) {
          toast(
            `Calibrated (${px}px), but your head barely moved during the head-movement dots - ` +
              `redo those and the cursor will survive you shifting position.`,
            'warn',
            5000,
          );
        } else {
          toast(`Calibrated - typical error ${px}px`, 'good', 2600);
        }
        console.info(
          `[gaze] mode=${model.mode} lambda=${model.lambda} ` +
            `cv=${model.cvErrorPx.toFixed(1)}px train=${model.trainErrorPx.toFixed(1)}px ` +
            `outlierFrac=${model.outlierFrac.toFixed(2)} ` +
            `samples=${result.samples.length} ` +
            `headSpread=yaw ${yaw.toFixed(3)} rad / pitch ${pitch.toFixed(3)} rad`,
        );
      } catch (err) {
        toast('Calibration failed, try again', 'warn', 3000);
        console.error(err);
        void this.runSetup();
        return;
      }
      this.overlay.setVisible(CONFIG.ui.debugOverlayDefault);
      this.showBoard();
    });
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
    this.dwell.setTargets(this.board.targets());
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
    // only feed the regression while the eyes are open - closed lids make the
    // iris landmarks meaningless and would yank the cursor across the screen.
    const point = closed ? this.estimator.point : this.estimator.update(frame);
    if (point) this.cursor.move(point);
    this.dwell.update(point, closed, t);
  }

  /* ---------------------------------------------------------------- selection */

  private onDwellFire(id: string, rect: DOMRect): void {
    this.board.flash(id);

    if (id.startsWith('word:')) {
      this.addConcept(id.slice(5));
      // gaze-confirmed only: a mouse click on the same tile goes through
      // board's onword callback, not this dwell-fire path, precisely because
      // a click tells us nothing about where the eyes actually were.
      if (!this.mouseMode) {
        this.estimator.recordImplicitCalibration({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        console.debug(
          `[gaze] implicit recal: ${this.estimator.implicitSampleCount} samples, ` +
            `cv=${this.estimator.errorPx.toFixed(1)}px outlierFrac=${this.estimator.outlierFrac.toFixed(2)}`,
        );
      }
    } else if (id.startsWith('cat:')) this.openCategory(id.slice(4) as CategoryId);
    else if (id === 'action:categories') this.showCategories();
    else if (id === 'action:clear') this.clearConcepts();
    else if (id === 'action:speak') this.speakRaw();
    else if (id === 'action:back') this.backToConcepts();
    else if (id.startsWith('cand:')) this.chooseCandidate(Number(id.slice(5)));
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

  /* ---------------------------------------------------------------- controls */

  // caregiver-only keys, nothing on screen for them. cursor is always iris +
  // head pose, so there's no mode switch.
  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key.toLowerCase()) {
      case 'd':
        this.overlay.setVisible(!this.overlay.isVisible());
        break;
      case 'c':
        if (this.phase === 'board') this.startCalibration();
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
