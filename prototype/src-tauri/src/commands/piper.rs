use base64::Engine;

#[derive(serde::Serialize)]
pub struct PiperResponse { status: u16, data: String }

fn endpoint(base_url: &str, route: &str, body: &str) -> Result<reqwest::Url, String> {
    let post = matches!(route, "download" | "synthesize");
    if !matches!(route, "voices" | "info" | "all-voices" | "download" | "synthesize") || post != !body.is_empty() {
        return Err("Некорректный запрос Piper.".into());
    }
    let url = reqwest::Url::parse(base_url).map_err(|_| "Некорректный адрес Piper.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Адрес Piper должен быть HTTP(S), без пароля и параметров.".into());
    }
    reqwest::Url::parse(&format!("{}/{route}", base_url.trim_end_matches('/'))).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn piper_http(base_url: String, route: String, body: String) -> Result<PiperResponse, String> {
    let url = endpoint(&base_url, &route, &body)?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(if route == "download" { 180 } else { 120 }))
        .build().map_err(|error| error.to_string())?;
    let request = if body.is_empty() { client.get(url) }
        else { client.post(url).header("Content-Type", "application/json").body(body) };
    let response = request.send().await.map_err(|error| format!("Piper недоступен: {error}"))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    Ok(PiperResponse { status, data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfers_catalog_bytes_without_cors_or_unicode_corruption() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\"voice\":\"Ирина\"}";
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /voices "));
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let response = tauri::async_runtime::block_on(piper_http(format!("http://{address}"), "voices".into(), String::new())).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(response.data).unwrap(), body.as_bytes());
        server.join().unwrap();
    }

    #[test]
    fn only_known_piper_routes_and_methods_are_allowed() {
        assert_eq!(endpoint("http://127.0.0.1:5000/", "voices", "").unwrap().as_str(), "http://127.0.0.1:5000/voices");
        assert!(endpoint("file:///etc", "voices", "").is_err());
        assert!(endpoint("http://localhost:5000?x=1", "voices", "").is_err());
        assert!(endpoint("http://localhost:5000", "../admin", "").is_err());
        assert!(endpoint("http://localhost:5000", "synthesize", "").is_err());
        assert!(endpoint("http://localhost:5000", "voices", "{}").is_err());
    }
}
