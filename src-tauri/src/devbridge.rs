// Dev-only HTTP eval bridge for smoke-testing the real webview from outside the app.
//
//   curl -s --data 'return document.title' http://127.0.0.1:7787/eval
//   curl -s --data 'return [...document.querySelectorAll("[data-index]")].length' .../eval
//
// POST /eval — body is a JS function body that `return`s a JSON-serializable value.
// We run it in a webview via `eval()`; the webview posts the result back to /result
// with `fetch` (the app's CSP is null in dev, so cross-port fetch is allowed). Add
// `?w=<label>` to target a specific window. Single-flight — intended for sequential
// curl calls. Debug builds only; never compiled into release.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ADDR: &str = "127.0.0.1:7787";
static RESULT_TX: Mutex<Option<Sender<String>>> = Mutex::new(None);

pub fn start(app: AppHandle) {
    std::thread::spawn(move || match TcpListener::bind(ADDR) {
        Ok(listener) => {
            eprintln!("[devbridge] eval bridge up — curl -s --data 'return document.title' http://{ADDR}/eval");
            for stream in listener.incoming().flatten() {
                // One thread per connection: an /eval blocks waiting for the webview's
                // /result callback, so the two must be served concurrently.
                let app = app.clone();
                std::thread::spawn(move || handle(&app, stream));
            }
        }
        Err(e) => eprintln!("[devbridge] could not bind {ADDR}: {e}"),
    });
}

fn handle(app: &AppHandle, mut stream: TcpStream) {
    let Some((path, body)) = read_request(&mut stream) else { return };

    if path.starts_with("/result") {
        if let Some(tx) = RESULT_TX.lock().unwrap().take() {
            let _ = tx.send(body);
        }
        respond(&mut stream, "ok");
        return;
    }

    if path.starts_with("/eval") {
        // ?w=<label> targets a specific window; otherwise the first webview.
        let want = path.split("w=").nth(1).map(|s| s.split('&').next().unwrap_or(s).to_string());
        let webview = app.webview_windows().into_iter().find_map(|(label, w)| match &want {
            Some(l) => (&label == l).then_some(w),
            None => Some(w),
        });
        let Some(webview) = webview else {
            respond(&mut stream, "{\"__error\":\"no matching webview\"}");
            return;
        };
        let (tx, rx) = channel();
        *RESULT_TX.lock().unwrap() = Some(tx);
        let js = format!(
            "(async()=>{{let r;try{{r=JSON.stringify(await(async()=>{{{body}}})())}}catch(e){{r=JSON.stringify({{__error:String((e&&e.stack)||e)}})}}try{{await fetch('http://{ADDR}/result',{{method:'POST',body:r}})}}catch(_){{}}}})()"
        );
        let _ = webview.eval(&js);
        let result = rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| "{\"__error\":\"timeout\"}".into());
        respond(&mut stream, &result);
        return;
    }

    respond(&mut stream, "{\"__error\":\"unknown path\"}");
}

/// Minimal HTTP/1.1 reader: returns (path, body), honoring Content-Length.
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let mut content_length = 0usize;
    let mut header_end: Option<usize> = None;
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let head = String::from_utf8_lossy(&buf[..pos]);
                for line in head.lines() {
                    let l = line.to_ascii_lowercase();
                    if let Some(v) = l.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
            }
        }
        if let Some(he) = header_end {
            if buf.len() >= he + content_length {
                break;
            }
        }
    }
    let he = header_end?;
    let request_line = String::from_utf8_lossy(&buf).lines().next()?.to_string();
    let path = request_line.split_whitespace().nth(1)?.to_string();
    let end = (he + content_length).min(buf.len());
    let body = String::from_utf8_lossy(&buf[he..end]).to_string();
    Some((path, body))
}

fn respond(stream: &mut TcpStream, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.flush();
}
