// Keeps Windows from opening a console window alongside the GUI in release
// builds. Debug builds keep it, because that is where panics and
// `println!` diagnostics are actually read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tabdump_lib::run()
}
