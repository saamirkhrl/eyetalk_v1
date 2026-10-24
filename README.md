<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo-wordmark-dark.svg" />
    <img src="public/logo-wordmark.svg" alt="EyeTalk" width="360" />
  </picture>
</p>

# EyeTalk

A gaze- and head-controlled AAC (augmentative and alternative communication) board that
runs entirely in your browser. It is built for people who cannot speak or type - for
example people living with ALS, cerebral palsy, or locked-in conditions - and for the
caregivers and families who talk with them. You build sentences by looking at words.

![EyeTalk stack: webcam to MediaPipe face landmarks to the gaze model (ridge regression, One
Euro filter, dwell selection) to Transformers.js running on WebGPU or WASM, then out to the
Web Speech API](docs/pipeline.png)

## Why this matters

Existing eye-gaze AAC systems usually need dedicated hardware and run hundreds to
thousands of dollars, putting them out of reach for a lot of families and clinics.
EyeTalk needs only a webcam and a browser: nothing leaves your machine, there is no
account, and no data is ever sent anywhere except a one-time model download. Open a
category, look at a word, hold your gaze until the ring fills, and an on-device language
model turns your picks into a full sentence and speaks it out loud.

## Try it live

[EyeTalk](https://eyetalkaac.vercel.app/)

First load downloads a language model (~570 MB on WebGPU, ~786 MB on the no-GPU fallback)
so it can run fully on-device; your browser caches it after that, so every later visit
starts instantly. Chrome or Edge is recommended - WebGPU generates sentences seconds
faster than the CPU fallback path.

## Run it locally

Prerequisites: Node.js 18+, a webcam, and Chrome or Edge (recommended).

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # gaze-math and vocabulary checks
```

## Vocabulary

The board opens on a ring of six categories. Each one opens a ring of eight words:

| Category | Words |
| --- | --- |
| Needs | water, food, bathroom, medicine, help, more, blanket, phone |
| Feelings | hurt, tired, happy, sad, scared, cold, hot, sick |
| People | mom, dad, brother, sister, friend, nurse, doctor, caregiver |
| Actions | stop, wait, go, eat, drink, sleep, move, read |
| Questions | what, where, when, who, why, how, how long, are you |
| Quick replies | yes, no, maybe, please, thank you, okay, not now, not sure |

Picked words stay selected while you move between categories, so one message can mix
words from several of them ("where" + "mom" becomes "Where is my mom?"). Speak and Clear
empty the selection and return to the categories.

The board is kept deliberately bare: the word ring and a few large action tiles, with no
status panels, history column or settings menu. The cursor always follows eyes and head
together, so there is no mode to pick.

## Controls

| Control | By gaze | Also |
| --- | --- | --- |
| Open a category | dwell on a category tile in the ring | click |
| Pick a word | dwell on a word tile in the ring | click |
| Back to the category ring | dwell on `Back to categories` | click |
| Speak / Clear / Back | dwell on a bottom action tile | click |
| Remove a picked word | - | click the selected word |
| Recalibrate | - | `C` (caregiver) |
| Stop speech | - | `S` (caregiver) |
| Landmark debug overlay | - | `D` (caregiver) |
| Cancel a selection in progress | shut both eyes briefly | - |

Every tile is also clickable, so the whole app works with just a mouse if the camera is
unavailable.

## Simulated test results

`npm test` checks the gaze math against synthetic calibration captures with a known true
mapping. These are simulated results, not measurements from real users or real webcams:

| Simulated scenario | Result |
| --- | --- |
| Ridge fit, held-out error on clean synthetic data | 0.797 px |
| ~8% corrupted frames: robust (Huber) fit vs naive fit | 18.8 px vs 63.3 px |
| User shifts position: grid only / 1-point sway / 4-corner sway | 244.9 px / 32.5 px / 21.3 px |
| Drift before vs after implicit recalibration (held-out tiles) | 128.9 px vs 18.9 px |
| One Euro filter under +-4 px input noise | 2.03 px max deviation |

It also checks that every one of the 48 words has its own template sentences, and that
the template fallback produces three sentences for every pair of words from two different
categories.

## Known limitations

- Webcam-only gaze tracking has a real accuracy floor - published appearance-based methods and
  commercial webcam trackers alike sit around 90-190 px of error on a laptop screen, not a
  number EyeTalk's software is failing to clear. The session-drift and outlier-frame problems
  that *are* fixable are; raw
  single-shot calibration precision on an arbitrary webcam is closer to a hardware limit.
- Gaze accuracy degrades if the user's head moves substantially past what the sway pass
  covered at calibration time; a genuinely different sitting position (new chair, moved
  desk) still needs a recalibration (`C`). Smaller drift over the course of a session -
  shifting in the seat, the laptop getting nudged - self-corrects from normal use.
- Vertical accuracy is inherently worse than horizontal.
- The on-device model is small (0.6B params on WebGPU, 0.5B on the CPU fallback) and can
  produce something clumsy or off-topic; the app filters the worst of it and tops up with templates either way.
- Blink-to-cancel is less reliable behind glasses with strong reflections.
- The vocabulary is a fixed set of 48 words in six categories. Words and categories cannot
  yet be added or edited from inside the app.
- Every word takes two selections (its category, then the word), so even an urgent word
  like "help" is two dwells away.
- Template-fallback sentences that combine several words are assembled from fixed
  patterns and can read stiffly ("Thank you, I want the nurse.").
- Nothing persists across a reload: the fitted calibration and current conversation are
  lost, so calibration needs to be redone.
- No way yet to re-speak a sentence from the conversation panel.

---

Curious how the gaze tracking, calibration, and fallback system actually work? See
[ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT
