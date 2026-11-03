use std::{
    io::Read,
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Request, Response, Server};
use uuid::Uuid;

const FIREBASE_API_KEY: &str = "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY";
const PROJECT_ID: &str = "shadow-controller-20261103";
const KEYRING_SERVICE: &str = "com.drincs.shadowcontroller";
const KEYRING_ACCOUNT: &str = "firebase.refresh-token";
const AUTH_PAGE: &str = include_str!("../auth-browser.html");
const AUTH_SCRIPT: &str = include_str!("../auth-browser.js");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthIdentity {
    uid: String,
    email: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    uid: String,
    email: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginCallback {
    state: String,
    id_token: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupResponse {
    users: Vec<FirebaseUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirebaseUser {
    local_id: String,
    email: Option<String>,
    email_verified: bool,
    provider_user_info: Vec<ProviderUserInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUserInfo {
    provider_id: String,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    #[serde(rename = "id_token")]
    id_token: String,
    #[serde(rename = "refresh_token")]
    refresh_token: String,
    #[serde(rename = "user_id")]
    user_id: String,
}

#[derive(Debug, Deserialize)]
struct FirebaseErrorResponse {
    error: FirebaseErrorBody,
}

#[derive(Debug, Deserialize)]
struct FirebaseErrorBody {
    message: String,
}

pub fn begin_login() -> Result<String, String> {
    let listener = TcpListener::bind(("localhost", 0))
        .map_err(|_| "Could not start the local sign-in listener".to_owned())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not determine the local sign-in address".to_owned())?
        .port();
    let server = Server::from_listener(listener, None)
        .map_err(|_| "Could not start the local sign-in listener".to_owned())?;
    let state = Uuid::new_v4().to_string();
    let origin = format!("http://localhost:{port}");
    let browser_url = format!("{origin}/auth?state={state}");

    thread::Builder::new()
        .name("shadow-firebase-login".to_owned())
        .spawn(move || serve_login(server, state, origin))
        .map_err(|_| "Could not start the local sign-in listener".to_owned())?;

    Ok(browser_url)
}

fn serve_login(server: Server, state: String, origin: String) {
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        let request = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(_) => return,
        };

        if request.method() == &Method::Get && request.url() == format!("/auth?state={state}") {
            let _ = request.respond(html_response(AUTH_PAGE, 200));
            continue;
        }
        if request.method() == &Method::Get && request.url() == "/auth-browser.js" {
            let _ = request.respond(content_response(AUTH_SCRIPT, 200, "text/javascript; charset=utf-8"));
            continue;
        }
        if request.method() == &Method::Get && request.url() == "/config" {
            let _ = request.respond(content_response(&firebase_config().to_string(), 200, "application/json"));
            continue;
        }

        if request.method() == &Method::Post && request.url() == "/complete" {
            if !has_origin(&request, &origin) {
                let _ = request.respond(html_response("Invalid sign-in origin.", 403));
                continue;
            }
            match accept_login(request, &state) {
                Ok(()) => return,
                Err(message) => {
                    let _ = message;
                }
            }
            continue;
        }

        let _ = request.respond(html_response("Not found.", 404));
    }
}

fn firebase_config() -> serde_json::Value {
    serde_json::json!({
        "apiKey": FIREBASE_API_KEY,
        "authDomain": "shadow-controller-20261103.firebaseapp.com",
        "projectId": PROJECT_ID,
        "appId": "1:561681360090:web:2af6f0a94083fbd85b31e3",
        "messagingSenderId": "561681360090"
    })
}

fn accept_login(mut request: Request, expected_state: &str) -> Result<(), String> {
    if !request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Content-Type") && header.value.as_str().starts_with("application/json"))
    {
        let _ = request.respond(html_response("Invalid sign-in request.", 415));
        return Err("Invalid content type".to_owned());
    }

    let mut body = String::new();
    if request
        .as_reader()
        .take(8193)
        .read_to_string(&mut body)
        .is_err()
        || body.len() > 8192
    {
        let _ = request.respond(html_response("Sign-in response is too large.", 413));
        return Err("Oversized sign-in response".to_owned());
    }
    let callback: LoginCallback = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(html_response("Invalid sign-in response.", 400));
            return Err("Invalid sign-in response".to_owned());
        }
    };
    if callback.state != expected_state {
        let _ = request.respond(html_response("Sign-in state did not match.", 403));
        return Err("Sign-in state mismatch".to_owned());
    }

    match validate_and_store(&callback.id_token, &callback.refresh_token) {
        Ok(()) => {
            let _ = request.respond(html_response("Sign-in complete. Return to Shadow Controller.", 200));
            Ok(())
        }
        Err(_) => {
            let _ = request.respond(html_response("Could not verify the Firebase sign-in. Try again.", 401));
            Err("Firebase sign-in verification failed".to_owned())
        }
    }
}

fn validate_and_store(id_token: &str, refresh_token: &str) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare Firebase verification".to_owned())?;
    let lookup = client
        .post(format!(
            "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={FIREBASE_API_KEY}"
        ))
        .json(&serde_json::json!({ "idToken": id_token }))
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Firebase rejected the sign-in".to_owned())?
        .json::<LookupResponse>()
        .map_err(|_| "Firebase returned an invalid identity response".to_owned())?;
    let user = lookup
        .users
        .into_iter()
        .next()
        .ok_or_else(|| "Firebase returned no signed-in user".to_owned())?;
    if !user.email_verified
        || !user
            .provider_user_info
            .iter()
            .any(|provider| provider.provider_id == "google.com")
    {
        return Err("The account must have a verified Google identity".to_owned());
    }
    let email = user
        .email
        .ok_or_else(|| "Firebase did not return an email address".to_owned())?;

    let refreshed = refresh_token_with(&client, refresh_token)?;
    if refreshed.user_id != user.local_id {
        return Err("Firebase token identity did not match".to_owned());
    }

    let credential = StoredCredential {
        uid: user.local_id,
        email,
        refresh_token: refreshed.refresh_token,
    };
    write_credential(&credential)
}

pub fn identity() -> Result<Option<AuthIdentity>, String> {
    Ok(read_credential()?.map(|credential| AuthIdentity {
        uid: credential.uid,
        email: credential.email,
    }))
}

pub fn id_token() -> Result<String, String> {
    let mut credential = read_credential()?.ok_or_else(|| "Not signed in".to_owned())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare Firebase token refresh".to_owned())?;
    let refreshed = refresh_token_with(&client, &credential.refresh_token)?;
    if refreshed.user_id != credential.uid {
        return Err("The stored Firebase credential belongs to a different account".to_owned());
    }
    credential.refresh_token = refreshed.refresh_token;
    write_credential(&credential)?;
    Ok(refreshed.id_token)
}

pub fn sign_out() -> Result<(), String> {
    let entry = credential_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the Firebase credential from the system keychain".to_owned()),
    }
}

fn read_credential() -> Result<Option<StoredCredential>, String> {
    match credential_entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "The stored Firebase credential is invalid".to_owned()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the Firebase credential from the system keychain".to_owned()),
    }
}

fn write_credential(credential: &StoredCredential) -> Result<(), String> {
    let value = serde_json::to_string(credential)
        .map_err(|_| "Could not prepare the Firebase credential".to_owned())?;
    credential_entry()?
        .set_password(&value)
        .map_err(|_| "Could not save the Firebase credential in the system keychain".to_owned())
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|_| "Could not open the system credential store".to_owned())
}

fn refresh_token_with(client: &Client, refresh_token: &str) -> Result<RefreshResponse, String> {
    let response = client
        .post(format!("https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|_| "Could not refresh the Firebase sign-in".to_owned())?;
    if !response.status().is_success() {
        let message = response
            .json::<FirebaseErrorResponse>()
            .map(|body| body.error.message)
            .unwrap_or_default();
        if message == "TOKEN_EXPIRED" || message == "USER_DISABLED" || message == "USER_NOT_FOUND" {
            return Err("The Firebase sign-in expired. Sign in again.".to_owned());
        }
        return Err("Firebase could not refresh the sign-in".to_owned());
    }
    response
        .json::<RefreshResponse>()
        .map_err(|_| "Firebase returned an invalid token response".to_owned())
}

fn has_origin(request: &Request, expected_origin: &str) -> bool {
    request.headers().iter().any(|header| {
        header.field.equiv("Origin") && header.value.as_str() == expected_origin
    })
}

fn html_response(body: &str, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    content_response(body, status, "text/html; charset=utf-8")
}

fn content_response(
    body: &str,
    status: u16,
    content_type: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body).with_status_code(status);
    let content_type = Header::from_bytes("Content-Type", content_type)
        .expect("static content-type header is valid");
    let cache_control = Header::from_bytes("Cache-Control", "no-store")
        .expect("static cache-control header is valid");
    let csp = Header::from_bytes(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' https://www.gstatic.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; base-uri 'none'; form-action 'none'",
    )
    .expect("static CSP header is valid");
    response.add_header(content_type);
    response.add_header(cache_control);
    response.add_header(csp);
    response
}

#[cfg(test)]
mod tests {
    #[test]
    fn login_page_has_no_embedded_or_persistent_auth_session() {
        let page = super::AUTH_PAGE;
        let script = super::AUTH_SCRIPT;
        assert!(page.contains("/auth-browser.js"));
        assert!(script.contains("inMemoryPersistence"));
        assert!(script.contains("signInWithPopup"));
        assert!(!script.contains("browserLocalPersistence"));
        assert!(!script.contains("localStorage"));
    }
}
