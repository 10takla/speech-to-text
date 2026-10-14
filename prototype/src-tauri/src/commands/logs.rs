use std::fs;

#[tauri::command]
pub fn get_app_logs() -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return crate::runtime_logs::read();
    }
    let logs_dir = crate::runtime_logs::dev_logs_dir();

    let entries = match fs::read_dir(logs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("app"))
        })
        .collect::<Vec<_>>();
    paths.sort();

    let mut logs = String::new();
    for path in paths {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("app log");
        let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        if !logs.is_empty() {
            logs.push_str("\n\n");
        }
        logs.push_str(&format!("--- {name} ---\n{contents}"));
    }
    Ok(logs)
}
