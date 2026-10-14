/**
 * A small website with one thing on it for each action an agent takes, for
 * actions.ts. On 127.0.0.1; the iframe comes from localhost, another origin.
 *
 *   /          links, a button, a search form, a select, a checkbox, a table, an iframe,
 *              a button inside a shadow root, a hidden link, a box at a known position,
 *              a popup link
 *   /second    where the link goes
 *   /search    shows what was searched
 *   /frame     the iframe's page: one button
 *   /list      20 items; 20 more each time you scroll to the end
 *   /spa       its text arrives from /data after the page loads
 *   /popup     what the popup link opens
 *   /login     sets a session cookie
 *   /whoami    shows the cookie it got
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface ActionSite {
  /** http://127.0.0.1:<port> */
  url: string
  close(): Promise<void>
}

const HOME = (port: number) => `<!doctype html>
<html><head><title>Action test</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; min-height: 1200px; }
  #box { position: absolute; left: 200px; top: 300px; width: 120px; height: 40px; background: #4a7; }
  main { margin-top: 380px; }
</style></head>
<body>
  <h1>Action test</h1>
  <nav><a href="/second">Go to second page</a> <a id="visible-link" href="/second">Visible link</a></nav>
  <div id="box"></div>
  <p id="box-out"></p>
  <main>
    <button onclick="document.getElementById('status').textContent='Saved'">Save</button>
    <p id="status"></p>
    <form action="/search"><label>Search <input name="q"></label></form>
    <label>Fruit <select id="fruit" onchange="document.getElementById('fruit-out').textContent=this.selectedOptions[0].text">
      <option>Apple</option><option>Banana</option><option>Cherry</option>
    </select></label>
    <p id="fruit-out"></p>
    <label><input type="checkbox" id="remember"> Remember me</label>
    <table id="prices">
      <tr><th>Item</th><th>Price</th></tr>
      <tr><td>Pen</td><td>$2.00</td></tr>
      <tr><td>Notebook</td><td>$12.50</td></tr>
    </table>
    <iframe title="Embedded" src="http://localhost:${port}/frame" width="300" height="80"></iframe>
    <shadow-card></shadow-card>
    <div style="display:none"><a id="hidden-link" href="/secret">Hidden link</a></div>
    <a href="/popup" target="_blank">Open popup</a>
  </main>
  <script>
    // Only a click at the box's own position reaches it.
    document.getElementById("box").addEventListener("click", () => {
      document.getElementById("box-out").textContent = "Clicked box"
    })
    customElements.define("shadow-card", class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" })
        root.innerHTML = '<button>Shadow button</button><span></span>'
        root.querySelector("button").addEventListener("click", () => {
          root.querySelector("span").textContent = "Shadow pressed"
        })
      }
    })
  </script>
</body></html>`

const FRAME = `<!doctype html><html><body><button onclick="this.textContent='Pressed'">Inner button</button></body></html>`

const LIST = `<!doctype html><html><head><title>List</title></head><body>
<h1>List</h1><ul id="items"></ul><div id="end" style="height:10px"></div>
<script>
  const list = document.getElementById("items")
  function addTwenty() {
    const start = list.children.length
    for (let i = start; i < start + 20; i++) {
      const item = document.createElement("li")
      item.textContent = "Item " + (i + 1)
      item.style.height = "60px"
      list.append(item)
    }
  }
  addTwenty()
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) addTwenty()
  }).observe(document.getElementById("end"))
</script></body></html>`

const SPA = `<!doctype html><html><head><title>App</title></head><body>
<div id="app">Loading…</div>
<script>
  setTimeout(async () => {
    const response = await fetch("/data")
    const data = await response.json()
    document.getElementById("app").innerHTML = "<h2>" + data.message + "</h2>"
  }, 300)
</script></body></html>`

export async function startActionSite(): Promise<ActionSite> {
  const server: Server = createServer((request, response) => {
    const port = (server.address() as AddressInfo).port
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    if (url.pathname === "/") {
      response.end(HOME(port))
    } else if (url.pathname === "/second") {
      response.end("<!doctype html><title>Second</title><h1>Second page</h1>")
    } else if (url.pathname === "/search") {
      const query = (url.searchParams.get("q") ?? "").replace(/[<>&]/g, "")
      response.end(`<!doctype html><title>Search</title><h1>Results for ${query}</h1>`)
    } else if (url.pathname === "/frame") {
      response.end(FRAME)
    } else if (url.pathname === "/list") {
      response.end(LIST)
    } else if (url.pathname === "/spa") {
      response.end(SPA)
    } else if (url.pathname === "/data") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ message: "Loaded from the server" }))
    } else if (url.pathname === "/popup") {
      response.end("<!doctype html><title>Popup</title><h1>Popup page</h1>")
    } else if (url.pathname === "/login") {
      response.setHeader("Set-Cookie", "session=abc123; Path=/; HttpOnly")
      response.end("<!doctype html><title>Signed in</title><h1>Signed in</h1>")
    } else if (url.pathname === "/whoami") {
      const cookie = (request.headers.cookie ?? "none").replace(/[<>&]/g, "")
      response.end(`<!doctype html><title>Who</title><p>Cookie: ${cookie}</p>`)
    } else {
      response.statusCode = 404
      response.end("<!doctype html><title>Not found</title><h1>Not found</h1>")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
