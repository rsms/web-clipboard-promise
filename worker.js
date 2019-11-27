const log = console.log.bind(console)
const connections = new Set()
const dataPromises = new Map()  // maps promise ID => data|{c:Connection,p:Promise}

// how long to wait to send a new ping after receiving a ping
const pingInterval = 1000  // ms

// when a connection has not responded to a ping in this amount of time,
// consider it dead and close it.
const deadAfter = 60000 // ms

const CancelError = new Error("canceled")


function addConnection(c) {
  connections.add(c)
  broadcast({ connectionCount: connections.size })
}

function removeConnection(c) {
  connections.delete(c)
  let deadPids = []
  for (let [pid, c2] of dataPromises) {
    if (c2 === c) {
      deadPids.push(pid)
    }
  }
  for (let pid of deadPids) {
    dataPromises.delete(pid)
  }
}

function broadcast(msg) {
  for (let c of connections) {
    c.send(msg)
  }
}


function handleRequest(c, request, data) {
  if (request == "resolve-data-promise") {
    let pid = data
    let v = dataPromises.get(pid)
    if (!v) {
      return Promise.reject(`no data promise with ID "${pid}"`)
    }
    if (!(v.p instanceof Promise)) {
      let req = v.c.request("resolve-data-promise", pid)
      let cancel = req.cancel
      req = req.then(data => {
        dataPromises.delete(pid)
        return data
      }).catch(err => {
        dataPromises.delete(pid)
        if (err !== CancelError) {
          console.error(`resolve-data-promise request failed: ${err.stack||err}`)
        }
      })
      req.cancel = cancel
      return req
    }
    return v.p
  }
  log("handleRequest unexpected", {request, data})
  return Promise.reject(`unexpected request "${request}"`)
}


class Connection {
  constructor(port) {
    this.port = port
    port.onmessage = ev => {
      // log("worker received message:", ev.data)
      if (ev.data == "close") {
        this.close()
      } else {
        this.onmsg(ev.data)
      }
    }
    port.onmessageerror = ev => {
      log("port message error", ev)
      this.close()
    }

    this.closed = false

    // Note: port.start() is required when using addEventListener("message").
    // It's called implicitly by onmessage setter.
    this.nextRequestId = 0
    this.inFlightRequests = new Map()
    this.incomingRequests = new Map()

    // keepalive ping
    this.pingTimer = null
    this.ping()
  }

  ping() {
    clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => {
      this.send(`ping`)
      this.pingTimer = setTimeout(() => {
        log(`no ping response after ${deadAfter}ms; closing connection`)
        this.close()
      }, deadAfter)
    }, pingInterval)
  }

  onmsg(msg) {
    if (msg == "pong") {
      // ping response -- connection is still alive
      this.ping()

    } else if ("request" in msg && "requestId" in msg) {
      let req = handleRequest(this, msg.request, msg.data)
      this.incomingRequests.set(msg.requestId, req)
      req.then(response => {
        this.incomingRequests.delete(msg.requestId)
        this.send({ response: msg.requestId, data: response })
      }).catch(err => {
        this.incomingRequests.delete(msg.requestId)
        this.send({ response: msg.requestId, error: String(err) })
      })

    } else if ("response" in msg) {
      let req = this.inFlightRequests.get(msg.response)
      if (req) {
        req.resolve(msg.data)
      }

    } else if ("cancelRequest" in msg) {
      let req = this.incomingRequests.get(msg.cancelRequest)
      log("canceling request", msg.cancelRequest, req, "req.cancel:", req.cancel)
      if (req && req.cancel) {
        req.cancel()
      }

    } else if ("register-data-promise" in msg) {
      let pid = msg["register-data-promise"]
      if (pid !== undefined) {
        dataPromises.set(pid, { c: this, p: null })
      }

    } else {
      console.warn(`ignoring unexpected message`, msg)
    }
  }

  send(data) {
    this.port.postMessage(data)
  }

  close() {
    if (!this.closed) {
      clearTimeout(this.pingTimer)
      this.closed = true
      this.port.onmessage = null
      this.port.close()
      removeConnection(this)
    }
  }

  request(request, data) {
    let requestId = this.nextRequestId++
    let reject
    let req = new Promise((resolve1, reject1) => {
      let resolve = value => (this.inFlightRequests.delete(requestId), resolve1(value))
      reject = reason => (this.inFlightRequests.delete(requestId), reject1(reason))
      this.inFlightRequests.set(requestId, {resolve, reject})
      this.send({ request, requestId, data })
    })
    req.cancel = reason => {
      reject(reason || CancelError)
      log("sending cancelRequest")
      this.send({ cancelRequest: requestId })
      req.cancel = ()=>{}
    }
    return req
  }
}


self.onconnect = ev => {
  log("new connection", ev)
  let c = new Connection(ev.ports[0])
  addConnection(c)
  // scheduleClose()  // close worker if there has been no activity in a while
}


let closeTimer = null
function scheduleClose() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => self.close(), 30000)
}
