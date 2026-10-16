// The navbar: solid once the page has scrolled, the link of the section on
// screen marked, and on a phone a menu button that opens the links.

const bar = document.getElementById("bar")

function onScroll() {
  bar.classList.toggle("scrolled", window.scrollY > 8)
}
window.addEventListener("scroll", onScroll, { passive: true })
onScroll()

// The section on screen: the last one whose top has passed a third of the way
// down the window. Only links to a section of this page take part.
const sectionLinks = [...bar.querySelectorAll(".bar-links a[data-section]")]
const sections = sectionLinks
  .map((link) => document.getElementById(link.dataset.section))
  .filter((section) => section !== null)

function markSection() {
  let current = null
  for (const section of sections) {
    if (section.getBoundingClientRect().top < window.innerHeight / 3) {
      current = section.id
    }
  }
  for (const link of sectionLinks) {
    if (link.dataset.section === current) {
      link.setAttribute("aria-current", "true")
    } else {
      link.removeAttribute("aria-current")
    }
  }
}
if (sections.length > 0) {
  window.addEventListener("scroll", markSection, { passive: true })
  markSection()
}

// The phone menu: opens and closes the sheet; following a link closes it.
const menuButton = bar.querySelector(".bar-menu")
const sheet = document.getElementById("bar-sheet")

function setMenu(open) {
  menuButton.setAttribute("aria-expanded", String(open))
  sheet.hidden = !open
}
menuButton.addEventListener("click", () => {
  setMenu(sheet.hidden)
})
sheet.addEventListener("click", (event) => {
  if (event.target.closest("a") !== null) {
    setMenu(false)
  }
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setMenu(false)
  }
})

// The research page's contents: open in the left margin on wide screens,
// with the section being read marked.
const contents = document.getElementById("contents")
if (contents !== null) {
  const wide = window.matchMedia("(min-width: 1520px)")
  function placeContents() {
    contents.open = wide.matches
  }
  wide.addEventListener("change", placeContents)
  placeContents()

  const contentLinks = [...contents.querySelectorAll("a")]
  function markContents() {
    let current = null
    for (const link of contentLinks) {
      const section = document.getElementById(link.getAttribute("href").slice(1))
      if (section !== null && section.getBoundingClientRect().top < window.innerHeight / 3) {
        current = link
      }
    }
    for (const link of contentLinks) {
      if (link === current) {
        link.setAttribute("aria-current", "true")
      } else {
        link.removeAttribute("aria-current")
      }
    }
  }
  window.addEventListener("scroll", markContents, { passive: true })
  markContents()
}
