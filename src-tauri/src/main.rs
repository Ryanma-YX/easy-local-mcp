#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    Manager, WebviewUrl, WindowEvent,
};
use url::Url;

fn control_url() -> Result<Url, String> {
    let raw = env::var("LOCALMCP_CONTROL_URL")
        .map_err(|_| "LOCALMCP_CONTROL_URL is required".to_string())?;
    let url = Url::parse(&raw)
        .map_err(|error| format!("Invalid LOCALMCP_CONTROL_URL: {error}"))?;

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
            "LOCALMCP_CONTROL_URL must be http://127.0.0.1:<port>/ with no credentials, query or fragment"
                .to_string(),
        );
    }

    Ok(url)
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
    let control = match control_url() {
        Ok(url) => url,
        Err(error) => {
            eprintln!("LocalMCP tray refused to start: {error}");
            std::process::exit(2);
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LocalMCP tray");
}
