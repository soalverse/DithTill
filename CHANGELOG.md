# Changelog

What changed in DithTill, release by release, written for the people who use it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-09

The first release. There is nothing to compare it to yet, so here is everything it does.

### Added

**One canvas for 1-bit art**

- Make dithered and halftone pictures and loops on one layered canvas, with photos, videos, drawings,
  dot-matrix text, music visualizers and a song, all stacked as layers.
- Drop in a photo or a video, or use **Layers +**, and it turns into 1-bit art straight away.
- Every layer has its own look: **Dither** (square bits in several patterns) or **Halftone** (round
  or shaped dots on an angled screen), with Dot size, Density, Tonal, Angle, Bit size, one ink or a
  palette, and its own dot colour. Overlapping inks print over each other like real screen
  printing, and **Solid** makes a layer cover what is underneath.
- Five error-diffusion patterns for Dither layers, at the bottom of the **Pattern** menu:
  **Floyd-Steinberg**, **Atkinson**, **Jarvis**, **Stucki** and **Sierra**, for an organic,
  photo-like grain with no visible grid. The grain shimmers when the picture moves, so pick **Blue**
  if you want a grain that stays calm.
- Effects for any layer, under **Effects** in the Animate list (**+ Add effect**): **Mirror** (left
  and right, top and bottom, or 4-way), **Kaleidoscope** (wedges and Turn), **Wave**, **Blur**,
  **Posterize** and **Outline**. They change the picture before it becomes dots, so the dots stay
  crisp, and every amount can move with ∿ on the beat, with the sound or along the timeline. Yes,
  you can spin a kaleidoscope in time with the song.
- A **Trail** effect with two kinds: **Echo** leaves fading copies of a moving layer where it just
  was, and **Smear** makes a video or a visualizer keep the brightest of its last moments, like a
  long exposure. Set its **Length** in beats and how much it **Fades**, and both can move with ∿. It
  shows while playing and in exported videos, which start with the trail already running.
- **Whole canvas effects:** select **Whole canvas** and use **+ Add effect** to put Mirror,
  Kaleidoscope, Wave, Blur, Posterize or Outline on the whole picture, about the middle of the
  canvas, so a Mirror reflects every layer across it. Each amount can move with ∿, like the canvas
  sliders.
- Halftone with **Tonal** off shows a **Pattern** menu, so you choose which same-size dots show: a
  grid's regular texture or **Blue**'s even scatter.
- **Drift** in every layer's Look slides its dots or bits slowly over the still picture, like film
  grain crawling, at a speed in beats and in any **Direction**. The speed can move with ∿.
- Seven palettes, plus any colour you pick for the background and the dots.
- Photo controls: Brightness, Contrast, Invert, Shadows / Mid-tones / Highlights, and **Cut out**,
  which removes a photo's background on your computer, and nothing is uploaded.
- Draw straight onto the canvas with a dithered brush. Each drawing is its own layer, a still picture.
- **Text** layers made of LED-sign dots, with Size, Spacing and Align.
- Fourteen music **visualizers** drawn for 1-bit, which can fill the canvas or sit as a layer.
- Crop any layer, or give it a **Window**, a box fixed on the canvas that the layer is seen through,
  so it can slide in and out of view.
- **Detail** Normal or Fine, for a finer screen.

**Animation and music**

- **Animate** any layer or the whole canvas. Under **Move it** are looping motions like Spin, Bounce,
  Pulse, Shake and Marquee, with speeds from ⅛× to 8×. Under **Change it** are any slider (Dot size,
  Density, Opacity, photo dials, text and visualizer settings) and hits like Flash, Palette and
  Invert.
- One **When** switch per move: on the **Beat**, with the **Sound** (Bass / Mid / Treble / Beat /
  Everything, quiet to loud), or along **Frame dots** you place on the timeline.
- Add a **song** and the picture moves to it. Set the **tempo** by typing it, tapping it, or letting
  DithTill detect it from the song, which also lines bar 1 up with the music.
- A **timeline** for clips with pause, speed and fades, a ruler in bars, snap to beats (hold Shift
  for free placement), zoom, and a metronome.
- Layers sit on the song: a layer you cut or move on the timeline shows exactly where you put it,
  once.
- Ctrl-drag the edge of any layer's bar to make it play slower or faster.
- Drag a video clip past the end of its footage and the footage plays again. A short video keeps
  playing through its whole clip.
- Drag along the timeline ruler to mark a part, and Play repeats just that part (✕ clears it).
- The video is exactly as long as your song, or your last layer when there is no song. With no song,
  drag a layer's bar past the end to make it longer.
- Record moves live while the loop plays, keep takes, and undo a take. Every layer you record has its
  own loop, so a take on one layer leaves the others alone, and the layer panel shows each layer's
  loop length.
- Each layer's bar on the timeline shows its takes and where its loop starts again. Mute a take from
  the bar's right-click menu.
- Drag the red handle on the ruler to move the playhead, even while the video plays, and it carries on
  from where you let go. A click on the ruler jumps there too.
- The timeline ruler shows the picked layer's loop, with an orange bracket over its first pass and a
  tick wherever it repeats. It appears once the layer has a loop, and while a Free take records it
  grows as you draw.
- Click the Loop length to pick it from a list: Free, 1 to 32 bars, Clip or Track. The − and + buttons
  wrap around, so + past the longest length comes back to Free, and − below Free goes to the longest.
- Loops always close: the last frame flows back into the first.

**Recordings**

- Draw while you record and you get a **Recording**, its own layer with its own bar, loop and Look. Pick
  a recording and record again to add a take on top of it. Anything else picked starts a new one just
  above that layer, its bar starting at your first stroke.
- Want the Look settled before you draw? **+ ▸ New recording** adds an empty recording, picked and
  ready. Set it up, press Rec, and your first stroke goes straight in.
- **Free** is an endless tape: it never wraps while you draw, and recording past the end of a picked
  Free recording makes it longer. With no song, the video grows as you draw. With a song, the take
  stops at the song's end, or at the end of a marked part.
- A Free recording plays once, its bar running from your first stroke to the moment you press Rec again,
  snapped to the nearest beat (hold Shift as you stop to keep it exact). Drag the bar's edge to run it
  longer. Bar lengths repeat to the end of the video.
- **Repeat or Hold:** past its drawing, a recording repeats or holds its finished picture. A chip on
  the bar, at the point its drawing ends, switches between them, and the held stretch is striped. So
  you can draw a face live, keep it up, then fade it, all on one bar.
- Right-click a recording's bar for **Merge with** another recording (it still looks the same, in one
  row), **Play backwards** (it un-draws itself), **Keep as drawing** (a still copy of the finished
  picture, from where it finishes to the end of the video) and **Undo take**.
- While stopped, the brush on a picked recording makes a new still drawing just above it, and the
  eraser rubs out its strokes at every moment, as one Undo.
- **Save to Library** on a recording (right-click its bar or its Layers row) saves the recording
  itself, strokes and timing included. Add it to any canvas and it is a recording again.
- Each recording holds up to 12 takes.
- The Loop length sets the length of new recordings, and you can change it after recording.
- The timeline's **Clear** removes recordings along with their takes, and Undo brings them back.
- While you record, the buttons you cannot use mid-take are greyed out (Library, Detail, Aspect, Tempo
  options, Add a track, + Add move, + Add effect and Project), and they come back when the take ends.
- Recordings are red with a ● on the timeline and in the Layers list, so you can find them.

**Saving and sharing**

- **Projects** save themselves as you work, and the app reopens the last one. The Projects shelf has
  thumbnails, rename, duplicate, delete and 10 recovery versions. Back up or share a project as a
  single `.dithtill` file.
- The **Library** keeps elements you save from the canvas, ready to drop into any project.
- Export a **PNG**, a vector **SVG** (real dots and bits), or a video: **MP4** with sound, at any
  length, or **GIF**, up to a minute. Exports are drawn by the same code as the canvas, and files are
  named after your project.
- Export the whole video or just the marked part. If a GIF would cut a loop off halfway, **Fit to N
  bars** marks a part that repeats cleanly.
- Video export works in the web version too, and the desktop app is faster at it.

**The app**

- One **Undo** for everything you do, in order. A slider drag is one step.
- Themes: Amber, Green screen, Soalverse violet, Ice, Rose, Neutral, or Match my canvas.
- **Hide UI** for a clean view (H), **Help**, and a power button, because a CRT should have one. Help
  opens as a card over the canvas from the **?** next to ⚙ or with **Esc** (Esc or a click outside
  closes it), with nine short topics on everything the app does.
- Runs fully offline as a desktop app, or in your browser at
  [dithtill.soalverse.com](https://dithtill.soalverse.com), where your work stays in that browser.
- The site opens on a cut-down copy of the app with one card in the middle: use it online, or download
  the desktop app for your computer. The screen behind the card is yours to draw on while you decide.
- DithTill is free and open source, under the Apache-2.0 licence.
- **Credits & licences** in the ⚙ menu names the people and projects DithTill is built on.
  `THIRD-PARTY-NOTICES.md` lists all of them with their licences, and comes with the app.
- DithTill has its own icon, the Soalverse halfmoon logo, on the desktop app and the browser tab.
- For the curious, the `original/` folder holds a look-only copy of the very first DithTill, the
  four-mode radio. Open `original/index.html` in a browser, and the tabs and the power button work.
