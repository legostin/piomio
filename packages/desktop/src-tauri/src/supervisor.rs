//! Runs the hub (or the machine daemon) as a child process on the bundled Node and keeps it running: output to a log
//! file, a restart after a crash, no more retries when it keeps crashing (five within two minutes), a clean stop
//! through its stdin (Windows has no SIGTERM for a windowless child). The child also stops when the pipe closes, so it
//! never outlives the app; on Windows a job object ends what it started, on macOS its process group.

use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
  Stopped,
  Starting,
  Running,
  Restarting,
  /// It kept crashing; Restart tries again.
  Failed,
  PortBusy(u16),
}

#[derive(Clone, Debug)]
pub struct Spec {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub env: Vec<(String, String)>,
  pub log: PathBuf,
  /// The hub's ports (web UI, console, egress proxy), checked before each start.
  pub ports: Vec<u16>,
  pub restart_delay: Duration,
  /// Lines on the child's stdout that start with this prefix go to the function (the rest of the line), not the log.
  pub notices: Option<(&'static str, fn(&str))>,
}

const LOG_LIMIT: u64 = 5 * 1024 * 1024;
const STOP_GRACE: Duration = Duration::from_secs(15);

/// The bundled Node: runtime/node.exe on Windows, runtime/<arm64|x64>/bin/node on macOS.
pub fn node_binary(app_root: &Path) -> PathBuf {
  if cfg!(windows) {
    app_root.join("runtime").join("node.exe")
  } else {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    app_root.join("runtime").join(arch).join("bin").join("node")
  }
}

/// A command with no console window on Windows.
pub fn command(program: &Path) -> Command {
  #[allow(unused_mut)]
  let mut cmd = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd
}

/// Five crashes within two minutes stop the retries.
pub struct Crashes {
  times: Vec<Instant>,
}

impl Crashes {
  pub fn new() -> Self {
    Crashes { times: Vec::new() }
  }

  /// Records a crash at `now`; true while it may start again.
  pub fn record(&mut self, now: Instant) -> bool {
    self.times.retain(|t| now.duration_since(*t) < Duration::from_secs(120));
    self.times.push(now);
    self.times.len() < 5
  }
}

/// Moves a log over `limit` bytes to <log>.1 (one previous log is kept).
pub fn rotate(log: &Path, limit: u64) -> io::Result<()> {
  match fs::metadata(log) {
    Ok(m) if m.len() > limit => fs::rename(log, log.with_extension("log.1")),
    _ => Ok(()),
  }
}

pub fn port_free(port: u16) -> bool {
  TcpListener::bind(("127.0.0.1", port)).is_ok()
}

struct Proc {
  child: Child,
  stdin: Option<ChildStdin>,
  /// Kill-on-close: dropping it ends everything the child started.
  #[cfg(windows)]
  _job: win32job::Job,
}

#[derive(Default)]
struct Inner {
  proc: Option<Proc>,
  /// Bumped by every start and stop: a watcher of an older generation gives up.
  generation: u64,
}

#[derive(Clone)]
pub struct Supervisor {
  inner: Arc<Mutex<Inner>>,
  listener: Arc<dyn Fn(Status) + Send + Sync>,
}

impl Supervisor {
  pub fn new(listener: impl Fn(Status) + Send + Sync + 'static) -> Self {
    Supervisor { inner: Arc::new(Mutex::new(Inner::default())), listener: Arc::new(listener) }
  }

  fn emit(&self, status: Status) {
    (self.listener)(status)
  }

  fn current(&self, generation: u64) -> bool {
    self.inner.lock().unwrap().generation == generation
  }

  /// Stops what runs now, then runs `spec` and keeps it running until `stop`.
  pub fn start(&self, spec: Spec) {
    self.stop();
    let generation = {
      let mut i = self.inner.lock().unwrap();
      i.generation += 1;
      i.generation
    };
    let me = self.clone();
    thread::spawn(move || me.watch(spec, generation));
  }

  /// Writes one line to the child's stdin; false when nothing runs.
  pub fn send_line(&self, line: &str) -> bool {
    let mut i = self.inner.lock().unwrap();
    match i.proc.as_mut().and_then(|p| p.stdin.as_mut()) {
      Some(stdin) => stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush()).is_ok(),
      None => false,
    }
  }

  /// `stop` on the child's stdin, a kill after 15 s. Blocks until it is gone.
  pub fn stop(&self) {
    let proc = {
      let mut i = self.inner.lock().unwrap();
      i.generation += 1;
      i.proc.take()
    };
    let Some(mut p) = proc else { return };
    if let Some(mut stdin) = p.stdin.take() {
      let _ = stdin.write_all(b"stop\n");
      let _ = stdin.flush();
    }
    let t0 = Instant::now();
    while t0.elapsed() < STOP_GRACE {
      if matches!(p.child.try_wait(), Ok(Some(_))) {
        break;
      }
      thread::sleep(Duration::from_millis(100));
    }
    end(p);
    self.emit(Status::Stopped);
  }

  fn watch(&self, spec: Spec, generation: u64) {
    let mut crashes = Crashes::new();
    loop {
      if let Some(port) = spec.ports.iter().copied().find(|p| !port_free(*p)) {
        self.emit(Status::PortBusy(port));
        return;
      }
      self.emit(Status::Starting);
      let proc = match spawn(&spec) {
        Ok(p) => p,
        Err(e) => {
          note(&spec.log, &format!("cannot start {}: {e}", spec.program.display()));
          self.emit(Status::Failed);
          return;
        }
      };
      {
        let mut i = self.inner.lock().unwrap();
        if i.generation != generation {
          drop(i);
          end(proc);
          return;
        }
        i.proc = Some(proc);
      }
      self.emit(Status::Running);
      // Poll for the exit without holding the lock, so stop() and send_line() reach the child.
      let exit = loop {
        thread::sleep(Duration::from_millis(250));
        let mut i = self.inner.lock().unwrap();
        if i.generation != generation {
          return;
        }
        let done = match i.proc.as_mut() {
          Some(p) => p.child.try_wait(),
          None => return,
        };
        let text = match done {
          Ok(None) => continue,
          Ok(Some(status)) => status.to_string(),
          Err(e) => e.to_string(),
        };
        if let Some(p) = i.proc.take() {
          drop(i);
          end(p);
        }
        break text;
      };
      note(&spec.log, &format!("the process ended ({exit})"));
      if !crashes.record(Instant::now()) {
        self.emit(Status::Failed);
        return;
      }
      self.emit(Status::Restarting);
      thread::sleep(spec.restart_delay);
      if !self.current(generation) {
        return;
      }
    }
  }
}

fn spawn(spec: &Spec) -> io::Result<Proc> {
  if let Some(dir) = spec.log.parent() {
    fs::create_dir_all(dir)?;
  }
  rotate(&spec.log, LOG_LIMIT)?;
  let log = OpenOptions::new().create(true).append(true).open(&spec.log)?;
  let out = log.try_clone()?;
  let mut cmd = command(&spec.program);
  cmd.args(&spec.args)
    .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
    .stdin(Stdio::piped())
    .stdout(if spec.notices.is_some() { Stdio::piped() } else { Stdio::from(out.try_clone()?) })
    .stderr(log);
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  #[cfg(windows)]
  let job = {
    let job = win32job::Job::create().map_err(io::Error::other)?;
    let mut info = job.query_extended_limit_info().map_err(io::Error::other)?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).map_err(io::Error::other)?;
    job
  };
  let mut child = cmd.spawn()?;
  #[cfg(windows)]
  {
    use std::os::windows::io::AsRawHandle;
    job.assign_process(child.as_raw_handle() as isize).map_err(io::Error::other)?;
  }
  let stdin = child.stdin.take();
  if let (Some(notices), Some(stdout)) = (spec.notices, child.stdout.take()) {
    thread::spawn(move || split_stdout(stdout, out, notices));
  }
  Ok(Proc {
    child,
    stdin,
    #[cfg(windows)]
    _job: job,
  })
}

/// Ends what is left of the child: its process group on macOS; on Windows dropping the job does it.
fn end(mut p: Proc) {
  #[cfg(unix)]
  unsafe {
    libc::killpg(p.child.id() as libc::pid_t, libc::SIGKILL);
  }
  let _ = p.child.kill();
  let _ = p.child.wait();
}

/// Copies the child's stdout into its log, except the lines meant for the app. Ends with the child.
fn split_stdout(stdout: impl Read, mut log: impl Write, (prefix, on): (&'static str, fn(&str))) {
  let mut lines = BufReader::new(stdout);
  let mut line = Vec::new();
  loop {
    line.clear();
    match lines.read_until(b'\n', &mut line) {
      Ok(0) | Err(_) => return,
      Ok(_) => {}
    }
    match line.strip_prefix(prefix.as_bytes()) {
      Some(rest) => on(String::from_utf8_lossy(rest).trim_end()),
      None => {
        let _ = log.write_all(&line);
      }
    }
  }
}

/// A line of the app's own in the child's log.
fn note(log: &Path, text: &str) {
  if let Some(dir) = log.parent() {
    let _ = fs::create_dir_all(dir);
  }
  if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log) {
    let _ = writeln!(f, "[piomio] {text}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("owl-supervisor-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
  }

  fn script(js: &str, log: PathBuf) -> Spec {
    Spec { program: "node".into(), args: vec!["-e".into(), js.into()], env: vec![], log, ports: vec![], restart_delay: Duration::from_millis(50), notices: None }
  }

  static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

  #[test]
  fn lines_for_the_app_skip_the_log() {
    let out = "starting\n\u{1e}note {\"id\":1}\nlistening\n\u{1e}note {\"id\":2}";
    let mut log = Vec::new();
    split_stdout(out.as_bytes(), &mut log, ("\u{1e}note ", |l| SEEN.lock().unwrap().push(l.to_string())));
    assert_eq!(String::from_utf8(log).unwrap(), "starting\nlistening\n");
    assert_eq!(*SEEN.lock().unwrap(), vec!["{\"id\":1}", "{\"id\":2}"]);
  }

  fn recorder() -> (Supervisor, Arc<Mutex<Vec<Status>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    (Supervisor::new(move |s| sink.lock().unwrap().push(s)), seen)
  }

  fn wait_for(seen: &Arc<Mutex<Vec<Status>>>, want: Status) {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(30) {
      if seen.lock().unwrap().contains(&want) {
        return;
      }
      thread::sleep(Duration::from_millis(50));
    }
    panic!("no {want:?} in {:?}", seen.lock().unwrap());
  }

  const ECHO: &str = r#"require("readline").createInterface({ input: process.stdin }).on("line", (l) => { console.log("got " + l); if (l === "stop") process.exit(0); }); setInterval(() => {}, 1000);"#;

  #[test]
  fn passes_lines_and_stops_through_stdin() {
    let log = tmp("echo").join("x.log");
    let (sup, seen) = recorder();
    sup.start(script(ECHO, log.clone()));
    wait_for(&seen, Status::Running);
    assert!(sup.send_line("ticket abc"));
    let t0 = Instant::now();
    sup.stop();
    assert!(t0.elapsed() < Duration::from_secs(10), "stop took {:?}", t0.elapsed());
    let text = fs::read_to_string(&log).unwrap();
    assert!(text.contains("got ticket abc") && text.contains("got stop"), "{text}");
    assert_eq!(seen.lock().unwrap().last(), Some(&Status::Stopped));
    assert!(!sup.send_line("late"));
  }

  #[test]
  fn restarts_a_crashing_child_then_gives_up() {
    let (sup, seen) = recorder();
    sup.start(script("process.exit(1)", tmp("crash").join("x.log")));
    wait_for(&seen, Status::Failed);
    let restarts = seen.lock().unwrap().iter().filter(|s| **s == Status::Restarting).count();
    assert_eq!(restarts, 4);
  }

  #[test]
  fn refuses_a_taken_port() {
    let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = taken.local_addr().unwrap().port();
    let (sup, seen) = recorder();
    let mut spec = script("setInterval(() => {}, 1000)", tmp("port").join("x.log"));
    spec.ports = vec![port];
    sup.start(spec);
    wait_for(&seen, Status::PortBusy(port));
  }

  #[test]
  fn counts_crashes_within_two_minutes() {
    let t = Instant::now();
    let mut c = Crashes::new();
    for _ in 0..4 {
      assert!(c.record(t));
    }
    assert!(!c.record(t));
    let mut c = Crashes::new();
    for i in 0..10 {
      assert!(c.record(t + Duration::from_secs(60 * i)));
    }
  }

  #[test]
  fn rotates_a_big_log() {
    let d = tmp("rotate");
    fs::create_dir_all(&d).unwrap();
    let log = d.join("hub.log");
    fs::write(&log, vec![b'x'; 100]).unwrap();
    rotate(&log, 50).unwrap();
    assert!(!log.exists());
    assert!(d.join("hub.log.1").exists());
  }
}
