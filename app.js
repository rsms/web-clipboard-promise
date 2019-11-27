(function(){

// how long to simulate that it takes to generate the copy payload
const resolveProgressDelay = 3000 // ms

// how long to wait for a remote instance to resolve on paste
const remoteResolveTimeout = 30000 // ms

const log = console.log.bind(console)
const copyTarget = document.getElementById("copy-target")
const pasteTarget = document.getElementById("paste")
const resolveProgress = document.getElementById("resolve-progress")
const waitProgress = document.getElementById("wait-progress")
const dataPromises = new Map()  // promise ID => data generator function
const inFlightRequests = new Map()
const workerUrl = "worker.js?v=2"
let resolveProgressCount = 0
let nextRequestId = 0
let worker
let useCliboardPromiseTechnique = true


// Are all the APIs needed available?
let incompatible = []
if (typeof SharedWorker == "undefined") {
  incompatible.push("Shared Worker API is unavailable")
}
if (!("clipboard" in navigator)) {
  incompatible.push("Clipboard API is unavailable")
}
if (!("permissions" in navigator)) {
  incompatible.push("Permission API unavailable")
} else if (!("request" in navigator.permissions)) {
  incompatible.push('Permission API "request" function unavailable')
}
if (incompatible.length > 0) {
  let div = document.getElementById("incompatible")
  div.classList.add("visible")
  let ul = div.querySelector("ul")
  incompatible.forEach(msg => {
    let li = document.createElement("li")
    li.innerText = msg
    ul.appendChild(li)
  })
  useCliboardPromiseTechnique = false
}


function resolveProgressIncr() {
  if (resolveProgressCount++ == 0) {
    resolveProgress.classList.add("visible")
  }
}

function resolveProgressDecr() {
  if (--resolveProgressCount == 0) {
    resolveProgress.classList.remove("visible")
  }
}


function resolveDataPromise(pid, isLocal) {
  let f = dataPromises.get(pid)
  if (!f) {
    return Promise.reject(`no such promise "${pid}"`)
  }
  if (isLocal) {
    log(`resolving data for local paster (pid ${pid})`)
  } else {
    log(`resolving data for remote paster (pid ${pid})`)
  }
  dataPromises.delete(pid)
  return resolveData(f, isLocal)
}


function resolveData(resolver, isLocal) {
  let p = resolver()
  if (!(p instanceof Promise)) {
    p = Promise.resolve(p)
  }
  if (!isLocal) {
    // add some fake delay
    p = p.then(data => fakeDelayWithProgress(resolveProgressDelay).then(() => data))
  }
  return p.then(data => {
    writeDataToClipboard(data)
    return data
  })
}


function writeDataToClipboard(data) {
  if (navigator.clipboard) {
    let item = new ClipboardItem({
      "text/plain": new Blob([data], {type: "text/plain"}),
    })
    navigator.clipboard.write([item]).then(() => {
      log("navigator.clipboard.write finished")
    }).catch(err => {
      log(`navigator.clipboard.write failed: ${err.stack||err}`)
    })
  }
}


function fakeDelayWithProgress(delay) {
  return new Promise(resolve => {
    resolveProgressIncr()
    setTimeout(() => {
      resolveProgressDecr()
      resolve()
    }, delay)
  })
}


function workerSend(msg) {
  worker.port.postMessage(msg)
}


function startWorker() {
  worker = new SharedWorker(workerUrl)
  worker.port.start()
  worker.port.onmessage = ev => {
    let msg = ev.data
    let canceledRequests = new Set()
    // if (msg != "ping") { log(`msg from worker:`, msg) }

    if (msg == "ping") {
      workerSend("pong")

    } else if ("response" in msg) {
      let req = inFlightRequests.get(msg.response)
      if (req) {
        req.resolve(msg.data)
      } else {
        console.warn(`got response from worker not in inFlightRequests`)
      }

    } else if ("request" in msg && "requestId" in msg) {
      handleWorkerRequest(msg.request, msg.data).then(data => {
        if (!canceledRequests.delete(msg.requestId)) {
          workerSend({ response: msg.requestId, data })
        }
      }).catch(err => {
        workerSend({ response: msg.requestId, error: String(err) })
      })

    } else if ("cancelRequest" in msg) {
      log("worker asked us to cancel request", msg.cancelRequest)
      canceledRequests.add(msg.cancelRequest)

    } else {
      log('unexpected message from worker:', msg)
    }
  }
  window.onunload = () => {
    workerSend("close")
  }
}


function handleWorkerRequest(req, data) {
  if (req == "resolve-data-promise") {
    return resolveDataPromise(data)
  }
  return Promise.reject(`unexpected request "${req}"`)
}


function workerRequest(request, data, timeout) {
  let requestId = nextRequestId++
  let reject
  let timeoutTimer
  let req = new Promise((resolve1, reject1) => {
    let resolve = data => (clearTimeout(timeoutTimer), resolve1(data))
    reject = reason => (clearTimeout(timeoutTimer), reject1(reason))
    inFlightRequests.set(requestId, {resolve, reject})
    workerSend({ request, requestId, data })
  })
  req.cancel = reason => {
    workerSend({ cancelRequest: requestId })  // TODO
    inFlightRequests.delete(requestId)
    reject(reason || new Error("canceled"))
    req.cancel = ()=>{}
  }
  if (timeout && timeout > 0) {
    timeoutTimer = setTimeout(() => req.cancel(new Error("timeout")), timeout)
  }
  return req
}


let permissions = {
  "clipboard-read": "?",
  "clipboard-write": "?",
}

// returns true if already granted
// returns false if already denied or unavailable
// returns Promise<true> if granted after asking the user
// returns Promise<false> if denied after asking the user
function getPermission(name) {
  if (permissions[name] == "granted") {
    return true
  }
  return navigator.permissions.request({ name }).then(status => {
    log(`permission request for clipboard-write => ${status.state}`)
    permissions[name] = status.state
    return status.state == "granted"
  })
}

function requestPermissions() {
  if (!navigator.permissions) {
    return
  }
  for (let name of Object.keys(permissions)) {
    navigator.permissions.query({name}).then(status => {
      status.onchange = () => {
        log(`permission state changed for "${name}" => ${status.state}`)
        permissions[name] = status.state
      }
      status.onchange()
    })
    .catch(() => {
      log("permissions API unavailable")
    })
  }
}



function copy(clipboardData) {
  let n = getSelection().anchorNode
  let someText = n.nodeType == Node.TEXT_NODE ? n.nodeValue : n.innerText
  let dataResolver = () => (new TextEncoder()).encode(someText)
  if (useCliboardPromiseTechnique) {
    let p = getPermission("clipboard-write")
    if (p instanceof Promise) {
      return p.then(() => copyAsync(clipboardData, dataResolver)), true
    }
    if (p) {
      return copyAsync(clipboardData, dataResolver), true
    }
  }
  copySync(clipboardData, dataResolver)
  return true
}


function copyAsync(clipboardData, dataResolver) {
  // we have clipboard-write permissions

  // write promise ID to the clipboard
  let pid = Date.now().toString(36)  // TODO: something better...
  // navigator.clipboard.writeText("figma-is-working-on-creating-clipboard-data-" + pid)

  // write promise ID to the clipboard
  clipboardData.setData('text/plain', "Figma is working on it...")
  clipboardData.setData('application/x-figma-clipboard-promise', pid)

  // send message to worker telling it about the promise id
  workerSend({ "register-data-promise": pid })

  // add data generator function to promise map
  dataPromises.set(pid, dataResolver)

  // TODO: begin creating clipboard data and write it to clipboard when done,
  // replacing the promise.
}


function copySync(clipboardData, dataResolver) {
  // we do not have clipboard-write permissions
  let data = dataResolver()  // blocks UI
  if (data instanceof Uint8Array) {
    data = (new TextDecoder()).decode(data)
  }
  clipboardData.setData('text/plain', data)
}


function paste(clipboardData) {
  let pid = clipboardData.getData('application/x-figma-clipboard-promise')
  if (pid) {
    if (dataPromises.has(pid)) {
      // local
      return resolveDataPromise(pid, /*isLocal*/true).then(finalizePaste)
    }

    log("send request to worker: resolve-data-promise")
    workerRequest("resolve-data-promise", pid, remoteResolveTimeout).then(data => {
      // log("resolve-data-promise:", data)
      // try and write to clipboard since chrome only allows focused doc to do so
      waitProgress.classList.remove("visible")
      writeDataToClipboard(data)
      finalizePaste(data)
    }).catch(err => {
      waitProgress.classList.remove("visible")
      console.error(`resolve-data-promise worker request failed: ${err}`)
      pasteTarget.innerText = ""+err
    })

    waitProgress.classList.add("visible")

    return true  // we're handling the paste event
  }

  if (data = clipboardData.getData('text/plain')) {
    finalizePaste(data)
    return true
  }
}


function finalizePaste(data) {
  let text = data instanceof Uint8Array ? (new TextDecoder()).decode(data) : String(data)
  pasteTarget.innerText = text.trim()
  pasteTarget.classList.add("updated")
  setTimeout(() => pasteTarget.classList.remove("updated"), 100)
}


function main() {
  if (useCliboardPromiseTechnique) {
    requestPermissions()
    startWorker()
  }

  document.addEventListener("paste", ev => {
    if (paste(ev.clipboardData)) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  })

  document.addEventListener("copy", ev => {
    if (copy(ev.clipboardData)) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  })
}


window.onload = main

})()


// MIME types supported by Clipboard API for writing:
//   text/plain
//   text/uri-list
//   text/csv
//   text/html
//   image/svg+xml
//   application/xml, text/xml
//   application/json
//
// MIME types supported by Clipboard API for reading:
//   text/plain
//   text/uri-list
//   text/csv
//   text/css
//   text/html
//   application/xhtml+xml
//   image/png
//   image/jpg, image/jpeg
//   image/gif
//   image/svg+xml
//   application/xml, text/xml
//   application/javascript
//   application/json
//   application/octet-stream
//
