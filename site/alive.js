// Living text, as accents:
//   glitchText(element)       a headline whose letters keep flickering into a
//                             pixel font and back, and resolve in on first view
//   decode(element, text)     text that resolves into place from random
//                             characters, left to right
// With reduced motion, headlines stay still and text appears at once.

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const ALIVE_STILL = window.matchMedia("(prefers-reduced-motion: reduce)").matches

function randomGlyph() {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
}

/**
 * Splits a headline into letters. A glitching letter keeps its Instrument Sans glyph
 * (made transparent) to hold its place, and its pixel twin is drawn on top
 * as an overlay that takes no space, so nothing on the page ever moves.
 */
function glitchText(element) {
  const text = element.textContent.replace(/\s+/g, " ").trim()
  element.setAttribute("aria-label", text)
  element.classList.add("glitch")
  element.textContent = ""
  const letters = []
  const words = text.split(" ")
  words.forEach((word, i) => {
    const wordSpan = document.createElement("span")
    wordSpan.className = "word"
    wordSpan.setAttribute("aria-hidden", "true")
    for (const char of word) {
      const letter = document.createElement("span")
      letter.className = "ch"
      letter.textContent = char
      letter.dataset.ch = char
      wordSpan.append(letter)
      letters.push(letter)
    }
    element.append(wordSpan)
    if (i < words.length - 1) {
      element.append(" ")
    }
  })

  /** One letter goes pixel for a moment. */
  function flicker(letter, ms) {
    letter.classList.add("px")
    setTimeout(() => letter.classList.remove("px"), ms)
  }

  document.fonts.ready.then(() => {
    if (ALIVE_STILL) {
      return
    }
    // First view: every letter starts pixel and resolves left to right.
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) {
        return
      }
      observer.disconnect()
      letters.forEach((letter, i) => {
        letter.classList.add("px")
        setTimeout(() => letter.classList.remove("px"), 260 + i * 28 + Math.random() * 160)
      })
    })
    observer.observe(element)
    // Then, now and again, a letter or two flickers.
    setInterval(() => {
      const count = Math.random() < 0.4 ? 2 : 1
      for (let i = 0; i < count; i++) {
        const letter = letters[Math.floor(Math.random() * letters.length)]
        if (letter.textContent.trim() !== "") {
          flicker(letter, 500 + Math.random() * 1400)
        }
      }
    }, 700)
    // Letters under the pointer go pixel too.
    for (const letter of letters) {
      letter.addEventListener("pointerenter", () => flicker(letter, 600))
    }
  })
}

/** Resolves `text` into `element` from random characters, left to right, over `ms`. */
function decode(element, text, ms = 700) {
  if (ALIVE_STILL) {
    element.textContent = text
    return
  }
  const started = performance.now()
  element.decodeRun = started
  function frame(now) {
    // A newer decode on the same element takes over.
    if (element.decodeRun !== started) {
      return
    }
    const done = Math.min(1, (now - started) / ms)
    const fixed = Math.floor(done * text.length)
    let shown = text.slice(0, fixed)
    for (let i = fixed; i < text.length; i++) {
      shown += text[i] === " " ? " " : randomGlyph()
    }
    element.textContent = shown
    if (done < 1) {
      requestAnimationFrame(frame)
    }
  }
  requestAnimationFrame(frame)
}

/** Decodes an element's own text the first time it scrolls into view. */
function decodeOnView(element, ms) {
  const text = element.textContent
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      observer.disconnect()
      decode(element, text, ms)
    }
  })
  observer.observe(element)
}
