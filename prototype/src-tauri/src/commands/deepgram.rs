use base64::Engine;

const DEEPGRAM_BASE_URL: &str = "https://api.deepgram.com";

#[derive(serde::Serialize)]
pub struct DeepgramHttpResponse {
    pub status: u16,
    pub body: String,
}

fn validate_endpoint(base_url: &str, method: &str, path_and_query: &str) -> Result<reqwest::Url, String> {
    if !matches!(method, "GET" | "POST") {
        return Err("Неподдерживаемый метод запроса Deepgram.".into());
    }
    if path_and_query.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err("Некорректный путь запроса Deepgram.".into());
    }
    let (route, query) = match path_and_query.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path_and_query, None),
    };
    let allowed = match method {
        "GET" => matches!(route, "/v1/auth/token" | "/v1/projects" | "/v1/models"),
        "POST" => route == "/v1/listen",
        _ => false,
    };
    if !allowed {
        return Err("Недопустимый маршрут Deepgram API.".into());
    }
    let trimmed_base = base_url.trim_end_matches('/');
    let full = match query {
        Some(q) => format!("{trimmed_base}{route}?{q}"),
        None => format!("{trimmed_base}{route}"),
    };
    reqwest::Url::parse(&full).map_err(|error| error.to_string())
}

async fn deepgram_http_to(
    base_url: &str,
    method: &str,
    path: &str,
    api_key: &str,
    content_type: Option<&str>,
    body_base64: Option<&str>,
) -> Result<DeepgramHttpResponse, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Deepgram: не указан API-ключ.".into());
    }
    let url = validate_endpoint(base_url, method, path)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;

    let mut request = if method == "POST" {
        let builder = client.post(url);
        let bytes = match body_base64 {
            Some(encoded) if !encoded.is_empty() => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| format!("Некорректное тело запроса Deepgram: {error}"))?,
            _ => Vec::new(),
        };
        builder.body(bytes)
    } else {
        client.get(url)
    };

    request = request.header("Authorization", format!("Token {key}"));
    if let Some(ct) = content_type.filter(|value| !value.trim().is_empty()) {
        request = request.header("Content-Type", ct.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Deepgram недоступен: {error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(DeepgramHttpResponse { status, body })
}

#[tauri::command]
pub async fn deepgram_http(
    method: String,
    path: String,
    api_key: String,
    content_type: Option<String>,
    body_base64: Option<String>,
) -> Result<DeepgramHttpResponse, String> {
    deepgram_http_to(
        DEEPGRAM_BASE_URL,
        &method,
        &path,
        &api_key,
        content_type.as_deref(),
        body_base64.as_deref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowed_deepgram_routes_and_methods_pass() {
        assert_eq!(
            validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/models").unwrap().as_str(),
            "https://api.deepgram.com/v1/models"
        );
        assert_eq!(
            validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/auth/token").unwrap().as_str(),
            "https://api.deepgram.com/v1/auth/token"
        );
        assert_eq!(
            validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/projects").unwrap().as_str(),
            "https://api.deepgram.com/v1/projects"
        );
        assert_eq!(
            validate_endpoint(DEEPGRAM_BASE_URL, "POST", "/v1/listen?model=nova-3&language=multi").unwrap().as_str(),
            "https://api.deepgram.com/v1/listen?model=nova-3&language=multi"
        );

        assert!(validate_endpoint(DEEPGRAM_BASE_URL, "DELETE", "/v1/models").is_err());
        assert!(validate_endpoint(DEEPGRAM_BASE_URL, "POST", "/v1/models").is_err());
        assert!(validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/listen").is_err());
        assert!(validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/projects/123/keys").is_err());
        assert!(validate_endpoint(DEEPGRAM_BASE_URL, "GET", "/v1/models\nHost: evil").is_err());
    }

    #[test]
    fn forwards_token_header_and_reads_utf8_body() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = "{\"stt\":[{\"canonical_name\":\"nova-3-general\"}]}";
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let count = stream.read(&mut request).unwrap();
            let text = String::from_utf8_lossy(&request[..count]);
            assert!(text.starts_with("GET /v1/models "));
            assert!(text.to_ascii_lowercase().contains("authorization: token dg_secret_key"));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let response = tauri::async_runtime::block_on(deepgram_http_to(
            &format!("http://{address}"),
            "GET",
            "/v1/models",
            "dg_secret_key",
            None,
            None,
        ))
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, body);
        server.join().unwrap();
    }
}
