use std::{
    io::Read,
    net::TcpListener,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant},
};

use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tiny_http::{Header, Method, Request, Response, Server};
use uuid::Uuid;

const FIREBASE_API_KEY: &str = "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY";
const PROJECT_ID: &str = "shadow-controller-20261103";
const FIRESTORE_DOCUMENTS_URL: &str = "https://firestore.googleapis.com/v1/projects/shadow-controller-20261103/databases/(default)/documents";
const KEYRING_SERVICE: &str = "com.drincs.shadowcontroller";
const KEYRING_ACCOUNT: &str = "firebase.refresh-token";
const SERVER_ID_KEYRING_ACCOUNT: &str = "server.identity";
// Keep the desktop portal on the same Firebase origin used as the SDK authDomain.
const AUTH_ORIGIN: &str = "https://shadow-controller-20261103.firebaseapp.com";
static ACTIVE_LOGIN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthIdentity {
    uid: String,
    email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedClient {
    id: String,
    display_name: String,
}

pub struct RelayCredentials {
    pub uid: String,
    pub server_id: String,
    pub id_token: String,
}

pub fn server_id() -> Result<String, String> {
    static SERVER_ID_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SERVER_ID_LOCK
        .lock()
        .map_err(|_| "Server identity state is unavailable".to_owned())?;
    let entry = Entry::new(KEYRING_SERVICE, SERVER_ID_KEYRING_ACCOUNT)
        .map_err(|_| "Could not open the system credential store".to_owned())?;
    match entry.get_password() {
        Ok(value) => {
            Uuid::parse_str(&value).map_err(|_| "Stored server identity is invalid".to_owned())?;
            Ok(value)
        }
        Err(keyring::Error::NoEntry) => {
            let value = Uuid::new_v4().to_string();
            entry
                .set_password(&value)
                .map_err(|_| "Could not save the server identity in the system credential store".to_owned())?;
            Ok(value)
        }
        Err(_) => Err("Could not read the server identity from the system credential store".to_owned()),
    }
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
    port: u16,
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

#[derive(Debug, Deserialize)]
struct FirestoreDocument {
    name: String,
    fields: Option<HashMap<String, FirestoreValue>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirestoreDocumentList {
    documents: Option<Vec<FirestoreDocument>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FirestoreValue {
    string_value: Option<String>,
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
    let browser_url = format!("{AUTH_ORIGIN}/auth?port={port}&login_session={state}");
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE_LOGIN.lock().map_err(|_| "Sign-in state is unavailable".to_owned())?;
        if let Some(previous) = active.replace(Arc::clone(&cancelled)) {
            previous.store(true, Ordering::Release);
        }
    }

    let worker_cancelled = Arc::clone(&cancelled);
    let spawn_result = thread::Builder::new()
        .name("shadow-firebase-login".to_owned())
        .spawn(move || serve_login(server, port, state, worker_cancelled));
    if spawn_result.is_err() {
        clear_active_login(&cancelled);
        return Err("Could not start the local sign-in listener".to_owned());
    }

    Ok(browser_url)
}

pub fn cancel_login() -> Result<(), String> {
    let mut active = ACTIVE_LOGIN.lock().map_err(|_| "Sign-in state is unavailable".to_owned())?;
    if let Some(cancelled) = active.take() {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

fn clear_active_login(cancelled: &Arc<AtomicBool>) {
    if let Ok(mut active) = ACTIVE_LOGIN.lock() {
        if active.as_ref().is_some_and(|current| Arc::ptr_eq(current, cancelled)) {
            active.take();
        }
    }
}

fn serve_login(server: Server, port: u16, state: String, cancelled: Arc<AtomicBool>) {
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline && !cancelled.load(Ordering::Acquire) {
        let request = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(request)) => request,
            Ok(None) => continue,
            Err(_) => break,
        };

        if request.url() != "/complete" || !has_origin(&request, AUTH_ORIGIN) {
            let _ = request.respond(cors_response(
                "Invalid sign-in origin.",
                403,
                Some(AUTH_ORIGIN),
            ));
            continue;
        }

        if request.method() == &Method::Options {
            let _ = request.respond(cors_response("", 204, Some(AUTH_ORIGIN)));
            continue;
        }
        if request.method() == &Method::Post {
            match accept_login(request, &state, port) {
                Ok(()) => break,
                Err(_) => continue,
            }
        }
    }
    clear_active_login(&cancelled);
}

fn accept_login(
    mut request: Request,
    expected_state: &str,
    expected_port: u16,
) -> Result<(), String> {
    if !request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Content-Type") && header.value.as_str().starts_with("application/json"))
    {
        let _ = request.respond(cors_response("Invalid sign-in request.", 415, Some(AUTH_ORIGIN)));
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
        let _ = request.respond(cors_response("Sign-in response is too large.", 413, Some(AUTH_ORIGIN)));
        return Err("Oversized sign-in response".to_owned());
    }
    let callback: LoginCallback = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(cors_response("Invalid sign-in response.", 400, Some(AUTH_ORIGIN)));
            return Err("Invalid sign-in response".to_owned());
        }
    };
    if callback.state != expected_state || callback.port != expected_port {
        let _ = request.respond(cors_response("Sign-in session did not match.", 403, Some(AUTH_ORIGIN)));
        return Err("Sign-in state mismatch".to_owned());
    }

    match validate_and_store(&callback.id_token, &callback.refresh_token) {
        Ok(()) => {
            let _ = request.respond(cors_response("Sign-in complete. Return to Shadow Controller.", 200, Some(AUTH_ORIGIN)));
            Ok(())
        }
        Err(_) => {
            let _ = request.respond(cors_response("Could not verify the Firebase sign-in. Try again.", 401, Some(AUTH_ORIGIN)));
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

pub fn current_uid() -> Result<Option<String>, String> {
    Ok(read_credential()?.map(|credential| credential.uid))
}

pub fn relay_credentials() -> Result<Option<RelayCredentials>, String> {
    let Some(credential) = read_credential()? else {
        return Ok(None);
    };
    if !pairing_status()? {
        return Ok(None);
    }
    Ok(Some(RelayCredentials {
        uid: credential.uid,
        server_id: server_id()?,
        id_token: id_token()?,
    }))
}

pub fn pairing_status() -> Result<bool, String> {
    let credential = read_credential()?.ok_or_else(|| "Sign in before checking server pairing".to_owned())?;
    let server_id = server_id()?;
    let token = id_token()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare Firebase pairing check".to_owned())?;
    let response = client
        .get(format!("{FIRESTORE_DOCUMENTS_URL}/accounts/{}", credential.uid))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Could not check Firebase server pairing".to_owned())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    let document = response
        .error_for_status()
        .map_err(|_| "Firebase could not check server pairing".to_owned())?
        .json::<FirestoreDocument>()
        .map_err(|_| "Firebase returned an invalid pairing record".to_owned())?;
    let registered_server_id = document
        .fields
        .and_then(|fields| fields.get("serverId").and_then(|value| value.string_value.clone()));
    match registered_server_id {
        Some(registered_server_id) if registered_server_id == server_id => Ok(true),
        Some(_) => Err("This account is paired with a different server. Remove that pairing before replacing it.".to_owned()),
        None => Err("The Firebase pairing record is missing its server identity".to_owned()),
    }
}

pub fn pair_server() -> Result<(), String> {
    if pairing_status()? {
        return Ok(());
    }
    let credential = read_credential()?.ok_or_else(|| "Sign in before pairing this server".to_owned())?;
    let server_id = server_id()?;
    let token = id_token()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare Firebase server pairing".to_owned())?;
    let response = client
        .post(format!("{FIRESTORE_DOCUMENTS_URL}:commit"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "writes": [{
                "update": {
                    "name": format!("{FIRESTORE_DOCUMENTS_URL}/accounts/{}", credential.uid),
                    "fields": { "serverId": { "stringValue": server_id } }
                },
                "currentDocument": { "exists": false }
            }]
        }))
        .send()
        .map_err(|_| "Could not save the Firebase server pairing".to_owned())?;
    if response.status().is_success() {
        return Ok(());
    }
    match pairing_status() {
        Ok(true) => return Ok(()),
        Err(message) if message.contains("paired with a different server") => return Err(message),
        _ => {}
    }
    Err("Firebase rejected the server pairing. Check the Firestore database and security rules.".to_owned())
}

pub fn unpair_server() -> Result<(), String> {
    if !pairing_status()? {
        return Ok(());
    }
    let credential = read_credential()?.ok_or_else(|| "Sign in before removing server pairing".to_owned())?;
    let token = id_token()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare Firebase server unpairing".to_owned())?;
    let response = client
        .delete(format!("{FIRESTORE_DOCUMENTS_URL}/accounts/{}", credential.uid))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Could not remove the Firebase server pairing".to_owned())?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err("Firebase rejected the server unpairing. Check the Firestore security rules.".to_owned())
    }
}

pub fn list_authorized_clients() -> Result<Vec<AuthorizedClient>, String> {
    if !pairing_status()? {
        return Err("Pair this server before managing authorized clients".to_owned());
    }
    let credential = read_credential()?.ok_or_else(|| "Sign in before managing authorized clients".to_owned())?;
    let token = id_token()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare the authorized-client list".to_owned())?;
    let response = client
        .get(format!("{FIRESTORE_DOCUMENTS_URL}/accounts/{}/authorizedClients?pageSize=100", credential.uid))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Could not read authorized clients from Firebase".to_owned())?
        .error_for_status()
        .map_err(|_| "Firebase rejected the authorized-client request".to_owned())?
        .json::<FirestoreDocumentList>()
        .map_err(|_| "Firebase returned an invalid authorized-client list".to_owned())?;

    Ok(response
        .documents
        .unwrap_or_default()
        .into_iter()
        .filter_map(|document| {
            let id = document.name.rsplit('/').next()?.to_owned();
            let display_name = document
                .fields?
                .get("displayName")?
                .string_value
                .clone()?;
            Some(AuthorizedClient { id, display_name })
        })
        .collect())
}

pub fn revoke_authorized_client(client_id: &str) -> Result<(), String> {
    Uuid::parse_str(client_id).map_err(|_| "Authorized client ID is invalid".to_owned())?;
    if !pairing_status()? {
        return Err("Pair this server before managing authorized clients".to_owned());
    }
    let credential = read_credential()?.ok_or_else(|| "Sign in before managing authorized clients".to_owned())?;
    let token = id_token()?;
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not prepare client revocation".to_owned())?;
    let response = client
        .delete(format!("{FIRESTORE_DOCUMENTS_URL}/accounts/{}/authorizedClients/{client_id}", credential.uid))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Could not revoke the Firebase client".to_owned())?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err("Firebase rejected the client revocation".to_owned())
    }
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

fn cors_response(
    body: &str,
    status: u16,
    origin: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body).with_status_code(status);
    for (name, value) in [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Access-Control-Max-Age", "300"),
        ("Vary", "Origin"),
    ] {
        response.add_header(Header::from_bytes(name, value).expect("static HTTP header is valid"));
    }
    if let Some(origin) = origin {
        response.add_header(Header::from_bytes("Access-Control-Allow-Origin", origin).expect("static origin is valid"));
    }
    response
}
