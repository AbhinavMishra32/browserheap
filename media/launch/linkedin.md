Introducing Browserheap: a browser for agents that never runs out of memory.
100 tabs in 1 GB. Every other agent browser ran out of memory by tab 67.
browserheap.com

Same 8 GB machine, same real websites, default settings for every browser. At 30 tabs, Browserheap uses 3.7× less memory than the next lightest, agent-browser.

Agents open a tab for every page they read and rarely close one. Today's agent browsers either let those tabs pile up until the machine is full, or close them and lose what the agent found. Browserheap keeps every tab. The two in use stay live; the rest sleep and wake the moment the agent needs them.

What's inside:
• 0.97 GB at 30 tabs (agent-browser 3.62 GB, headless Chrome 4.42 GB)
• 3% CPU while the agent thinks (headless Chrome 642%)
• Sleeping tabs stay readable and searchable, with no reload
• Full Chromium: 19 of 19 agent actions work, as in Chrome
• Cookies kept between runs; from a home connection, 0 of 22 bot-checking sites turned it away
• Works in Claude Code, Codex, any agent's shell, or as a Node library

Every number and the full method: browserheap.com/research

Try it in Claude Code:
npx browserheap skill claude

browserheap.com
