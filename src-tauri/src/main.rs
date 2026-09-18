#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs::{create_dir_all, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    Manager, WebviewUrl, WindowEvent,
};
use url::Url;

struct HostProcess(Mutex<Option<Child>>);

impl HostProcess {
    fn set(&self, child: Child) {
        *self.0.lock().expect("host process lock poisoned") = Some(child);
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn parse_control_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw)
        .map_err(|error| format!("Invalid LocalMCP Control Center URL: {error}"))?;

    let allowed =
        url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/";

    if !allowed {
        return Err(
            "Control Center URL must be http://127.0.0.1:<port>/ with no credentials, query or fragment"
                .to_string(),
        );
    }

    Ok(url)
}

fn portable_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }

    path
}

fn start_bundled_host(app: &tauri::AppHandle) -> Result<(Url, Child), String> {
    let resource_dir = portable_path(app.path().resource_dir().map_err(|error| error.to_string())?);
    let runtime_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = resource_dir.join("runtime").join(runtime_name);
    let script = resource_dir.join("app").join("dist").join("index.js");

    if !node.is_file() {
        return Err(format!("Bundled Node runtime not found: {}", node.display()));
    }

    if !script.is_file() {
        return Err(format!("Bundled LocalMCP host not found: {}", script.display()));
    }

    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let log_dir = app.path().app_log_dir().map_err(|error| error.to_string())?;
    create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("desktop-host.log"))
        .map_err(|error| error.to_string())?;
    writeln!(
        log,
        "launcher node={} script={} home={} resource_dir={}",
        node.display(),
        script.display(),
        home.display(),
        resource_dir.display()
    )
    .map_err(|error| error.to_string())?;
    log.flush().map_err(|error| error.to_string())?;

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .arg("desktop-host")
        .current_dir(home)
        .env("LOCALMCP_DESKTOP_BUNDLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start bundled LocalMCP host: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Bundled LocalMCP host stdout is unavailable".to_string())?;

    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let _ = sender.send(line);
                }
                Err(_) => break,
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        let now = Instant::now();
        if now >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Timed out waiting for bundled LocalMCP Control Center".to_string());
        }

        let remaining = deadline.saturating_duration_since(now);
        match receiver.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(raw) = line.strip_prefix("LOCALMCP_CONTROL_URL=") {
                    let url = parse_control_url(raw)?;
                    return Ok((url, child));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Timed out waiting for bundled LocalMCP Control Center".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.try_wait().ok().flatten();
                return Err(format!("Bundled LocalMCP host exited before it became ready: {status:?}"));
            }
        }
    }
}

fn resolve_control(app: &tauri::AppHandle) -> Result<(Url, Option<Child>), String> {
    if let Ok(raw) = env::var("LOCALMCP_CONTROL_URL") {
        return parse_control_url(&raw).map(|url| (url, None));
    }

    start_bundled_host(app).map(|(url, child)| (url, Some(child)))
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(HostProcess(Mutex::new(None)))
        .setup(|app| {
            let (control, bundled_host) = resolve_control(app.handle())
                .map_err(std::io::Error::other)?;
            let navigation_target = control.clone();

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(control.clone()),
            )
            .title("LocalMCP Control Center")
            .inner_size(1180.0, 820.0)
            .min_inner_size(860.0, 620.0)
            .center()
            .on_navigation(move |url| {
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port_or_known_default()
                        == navigation_target.port_or_known_default()
            })
            .build()?;

            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });

            let show = MenuItem::with_id(
                app,
                "show",
                "Show Control Center",
                true,
                None::<&str>,
            )?;
            let hide = MenuItem::with_id(
                app,
                "hide",
                "Hide Control Center",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit LocalMCP Desktop",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("LocalMCP")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "hide" => hide_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;

            if let Some(child) = bundled_host {
                app.state::<HostProcess>().set(child);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LocalMCP tray");
}
