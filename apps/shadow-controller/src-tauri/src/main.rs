// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|argument| argument == "--coordinator") {
        if let Err(error) = shadow_controller_desktop_lib::run_coordinator_from_environment() {
            eprintln!("Coordinator stopped: {error}");
            std::process::exit(1);
        }
        return;
    }

    shadow_controller_desktop_lib::run()
}
