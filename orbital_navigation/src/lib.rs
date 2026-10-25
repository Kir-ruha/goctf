use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

type Answer = Result<Value, String>;
type Headers = HashMap<String, String>;
type HttpResponse<'a> = (u16, Headers, &'a [u8]);
type HttpRequest = (String, String, Headers, Vec<u8>);

#[derive(Clone)]
pub struct Server {
    state: Arc<Mutex<State>>,

    root: PathBuf,

    importer_key: String,
}

#[derive(Default)]
struct State {
    next: u64,
    users: HashMap<String, String>,
    ships: HashMap<String, String>,
    messages: HashMap<String, Vec<String>>,
    sources: HashMap<String, String>,
    profiles: HashMap<String, Profile>,
    jobs: HashMap<String, Job>,
    flights: HashMap<String, Flight>,
    geometry_cache: HashMap<String, String>,
    grants: HashMap<String, Grant>,
    summaries: HashMap<String, Summary>,
    imports: HashMap<String, (String, String)>,
    packages: HashMap<String, Package>,
}

struct Profile {
    owner: String,
    ship: String,
}
struct Job {
    owner: String,
    profile: String,
    result: Option<Vec<String>>,
}
struct Flight {
    owner: String,
    geometry: String,
    map_version: String,
    options: String,
    manifest: String,
}
struct Grant {
    flight: String,
    subject: String,
    rights: Vec<String>,
    expires: u64,
}
struct Summary {
    owner: String,
    content: String,
}
struct Package {
    owner: String,
    bytes: Vec<u8>,
    approved: bool,
}

impl State {
    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}-{}", self.next)
    }
    fn user(&self, token: &str) -> Result<String, String> {
        self.users
            .get(token)
            .cloned()
            .ok_or_else(|| "invalid token".into())
    }
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))
}

fn owned(v: &Value, key: &str) -> Result<String, String> {
    Ok(field(v, key)?.to_owned())
}

fn check_owner(actual: &str, user: &str) -> Result<(), String> {
    if actual == user {
        Ok(())
    } else {
        Err("forbidden".into())
    }
}

fn canonical(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn cache_key(f: &Flight) -> String {
    format!("{}\0{}\0{}", f.geometry, f.map_version, f.options)
}

impl Server {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(root.join("navigation"))?;

        fs::create_dir_all(root.join("work"))?;

        Ok(Self {
            state: Arc::new(Mutex::new(State::default())),
            root,
            importer_key: "orbit-importer-service-key".into(),
        })
    }

    pub fn rpc(&self, v: Value) -> Answer {
        let action = field(&v, "action")?;

        if action == "register" {
            let mut s = self.state.lock().unwrap();
            let id = s.id("user");
            let token = format!("token-{id}");

            s.users.insert(token.clone(), id.clone());

            return Ok(json!({"user_id":id,"token":token}));
        }

        let token = field(&v, "token")?;

        let user = self.state.lock().unwrap().user(token)?;

        match action {
            "create_ship" => {
                let mut s = self.state.lock().unwrap();
                let id = s.id("ship");
                s.ships.insert(id.clone(), user.clone());
                s.sources.insert(id.clone(), user);
                Ok(json!({"ship_id":id}))
            }
            "post_message" => {
                let ship = field(&v, "ship_id")?;
                let msg = owned(&v, "message")?;
                let mut s = self.state.lock().unwrap();
                check_owner(s.ships.get(ship).ok_or("unknown ship")?, &user)?;
                s.messages.entry(ship.into()).or_default().push(msg);
                Ok(json!({"ok":true}))
            }
            "bind_source" => {
                let source = owned(&v, "source_id")?;

                let mut s = self.state.lock().unwrap();

                if s.sources.contains_key(&source) {
                    return Err("source exists".into());
                }
                if !s.ships.contains_key(&canonical(&source)) {
                    return Err("unknown ship".into());
                }
                s.sources.insert(source, user);
                Ok(json!({"ok":true}))
            }
            "read_source_messages" => {
                let source = field(&v, "source_id")?;

                let s = self.state.lock().unwrap();

                check_owner(s.sources.get(source).ok_or("unknown source")?, &user)?;

                let ship = canonical(source);
                Ok(json!({"messages":s.messages.get(&ship).cloned().unwrap_or_default()}))
            }
            "create_profile" => {
                let ship = owned(&v, "ship_id")?;
                let mut s = self.state.lock().unwrap();
                check_owner(s.ships.get(&ship).ok_or("unknown ship")?, &user)?;

                let id = s.id("profile");
                s.profiles.insert(id.clone(), Profile { owner: user, ship });
                Ok(json!({"profile_id":id}))
            }
            "create_export" => {
                let profile = owned(&v, "profile_id")?;
                let mut s = self.state.lock().unwrap();
                let p = s.profiles.get(&profile).ok_or("unknown profile")?;

                check_owner(&p.owner, &user)?;

                check_owner(s.ships.get(&p.ship).ok_or("unknown ship")?, &user)?;
                let id = s.id("job");
                s.jobs.insert(
                    id.clone(),
                    Job {
                        owner: user,
                        profile,
                        result: None,
                    },
                );
                Ok(json!({"job_id":id,"state":"DRAFT"}))
            }
            "edit_profile" => {
                let id = field(&v, "profile_id")?;
                let ship = owned(&v, "ship_id")?;
                let mut s = self.state.lock().unwrap();

                if !s.ships.contains_key(&ship) {
                    return Err("unknown ship".into());
                }
                let p = s.profiles.get_mut(id).ok_or("unknown profile")?;
                check_owner(&p.owner, &user)?;
                p.ship = ship;
                Ok(json!({"ok":true}))
            }
            "run_export" => {
                let id = field(&v, "job_id")?;

                let mut s = self.state.lock().unwrap();
                let job = s.jobs.get(id).ok_or("unknown job")?;
                check_owner(&job.owner, &user)?;

                if job.result.is_some() {
                    return Err("already run".into());
                }

                let ship = s
                    .profiles
                    .get(&job.profile)
                    .ok_or("unknown profile")?
                    .ship
                    .clone();

                let result = s.messages.get(&ship).cloned().unwrap_or_default();

                s.jobs.get_mut(id).ok_or("unknown job")?.result = Some(result.clone());
                Ok(json!({"messages":result,"state":"DONE"}))
            }
            "export_result" => {
                let id = field(&v, "job_id")?;

                let s = self.state.lock().unwrap();

                let job = s.jobs.get(id).ok_or("unknown job")?;

                check_owner(&job.owner, &user)?;

                Ok(
                    json!({"messages":job.result,"state":if job.result.is_some(){"DONE"}else{"DRAFT"}}),
                )
            }
            "create_flight" => {
                let geometry = owned(&v, "geometry")?;

                let version = owned(&v, "map_version")?;

                let options = owned(&v, "options")?;

                let manifest = owned(&v, "manifest")?;

                let nav = owned(&v, "navigation")?;

                let mut s = self.state.lock().unwrap();

                let id = s.id("flight");

                let f = Flight {
                    owner: user,
                    geometry,
                    map_version: version,
                    options,
                    manifest,
                };

                fs::write(self.root.join("navigation").join(format!("{id}.txt")), nav)
                    .map_err(|e| e.to_string())?;

                let key = cache_key(&f);

                s.geometry_cache.entry(key).or_insert_with(|| id.clone());

                s.flights.insert(id.clone(), f);

                Ok(json!({"flight_id":id}))
            }
            "flight_public" => {
                let id = field(&v, "flight_id")?;

                let s = self.state.lock().unwrap();

                let f = s.flights.get(id).ok_or("unknown flight")?;

                Ok(json!({"geometry":f.geometry,"map_version":f.map_version,"options":f.options}))
            }
            "report" => {
                let id = field(&v, "flight_id")?;

                let s = self.state.lock().unwrap();

                let f = s.flights.get(id).ok_or("unknown flight")?;

                check_owner(&f.owner, &user)?;

                let cached_flight = s.geometry_cache.get(&cache_key(f)).ok_or("cache miss")?;

                let manifest = &s.flights.get(cached_flight).ok_or("stale cache")?.manifest;

                Ok(json!({"geometry":f.geometry,"manifest":manifest}))
            }
            "grant_geometry" => {
                let flight = owned(&v, "flight_id")?;

                let mut s = self.state.lock().unwrap();

                check_owner(
                    &s.flights.get(&flight).ok_or("unknown flight")?.owner,
                    &user,
                )?;
                let id = s.id("grant");

                s.grants.insert(
                    id.clone(),
                    Grant {
                        flight,
                        subject: "public".into(),
                        rights: vec!["geometry.read".into(), "delegate".into()],
                        expires: u64::MAX,
                    },
                );
                Ok(json!({"grant_id":id}))
            }
            "delegate" => {
                let parent_id = field(&v, "parent_id")?;

                let rights = v
                    .get("rights")
                    .and_then(Value::as_array)
                    .ok_or("missing rights")?
                    .iter()
                    .map(|x| x.as_str().map(str::to_owned).ok_or("invalid right"))
                    .collect::<Result<Vec<_>, _>>()?;

                let expires = v
                    .get("expires")
                    .and_then(Value::as_u64)
                    .ok_or("missing expires")?;
                let mut s = self.state.lock().unwrap();

                let p = s.grants.get(parent_id).ok_or("unknown grant")?;

                if p.subject != "public" && p.subject != user {
                    return Err("forbidden".into());
                }
                if !p.rights.iter().any(|x| x == "delegate") || expires > p.expires {
                    return Err("invalid delegation".into());
                }
                let flight = p.flight.clone();

                let id = s.id("grant");

                s.grants.insert(
                    id.clone(),
                    Grant {
                        flight,
                        subject: user,
                        rights,
                        expires,
                    },
                );
                Ok(json!({"grant_id":id}))
            }
            "read_manifest" => {
                let flight = field(&v, "flight_id")?;

                let s = self.state.lock().unwrap();

                let f = s.flights.get(flight).ok_or("unknown flight")?;

                if f.owner != user {
                    let grant = field(&v, "grant_id")?;

                    let g = s.grants.get(grant).ok_or("unknown grant")?;

                    if !(g.flight == flight
                        && g.subject == user
                        && g.rights.iter().any(|x| x == "manifest.read"))
                    {
                        return Err("forbidden".into());
                    }
                }
                Ok(json!({"manifest":f.manifest}))
            }
            "create_summary" => {
                let content = owned(&v, "content")?;

                let mut s = self.state.lock().unwrap();

                let id = s.id("summary");

                s.summaries.insert(
                    id.clone(),
                    Summary {
                        owner: user,
                        content,
                    },
                );

                Ok(json!({"summary_id":id}))
            }
            "read_summary" => {
                let id = field(&v, "summary_id")?;

                let s = self.state.lock().unwrap();

                let summary = s.summaries.get(id).ok_or("unknown summary")?;

                check_owner(&summary.owner, &user)?;

                Ok(json!({"content":summary.content}))
            }
            "read_navigation" => {
                let id = field(&v, "flight_id")?;

                {
                    let s = self.state.lock().unwrap();

                    let flight = s.flights.get(id).ok_or("unknown flight")?;

                    check_owner(&flight.owner, &user)?;
                }

                let content =
                    fs::read_to_string(self.root.join("navigation").join(format!("{id}.txt")))
                        .map_err(|e| e.to_string())?;

                Ok(json!({"navigation":content}))
            }
            "import_bulletin" => {
                let url = field(&v, "url")?;

                let (host, _, _) = parse_url(url)?;

                if host == "127.0.0.1" || host == "localhost" {
                    return Err("internal source forbidden".into());
                }

                let result = self.fetch_bulletin(url)?;

                let mut s = self.state.lock().unwrap();

                let id = s.id("import");

                s.imports.insert(id.clone(), (user, result.clone()));

                Ok(json!({"import_id":id,"content":result}))
            }
            "import_result" => {
                let id = field(&v, "import_id")?;

                let s = self.state.lock().unwrap();

                let (owner, content) = s.imports.get(id).ok_or("unknown import")?;

                check_owner(owner, &user)?;

                Ok(json!({"content":content}))
            }
            "create_package" => {
                let mut s = self.state.lock().unwrap();

                let id = s.id("package");

                s.packages.insert(
                    id.clone(),
                    Package {
                        owner: user,
                        bytes: Vec::new(),
                        approved: false,
                    },
                );
                Ok(json!({"package_id":id}))
            }
            "approve_package" => {
                let id = field(&v, "package_id")?;

                let mut s = self.state.lock().unwrap();

                let p = s.packages.get_mut(id).ok_or("unknown package")?;

                check_owner(&p.owner, &user)?;

                validate_safe_tar(&p.bytes)?;

                p.approved = true;

                Ok(json!({"approved":true}))
            }
            "generate_report" => {
                let id = field(&v, "package_id")?;

                let attachment = field(&v, "attachment")?;

                let bytes = {
                    let s = self.state.lock().unwrap();

                    let p = s.packages.get(id).ok_or("unknown package")?;

                    check_owner(&p.owner, &user)?;

                    if !p.approved {
                        return Err("package not approved".into());
                    }
                    p.bytes.clone()
                };
                if !safe_relative(Path::new(attachment)) {
                    return Err("invalid attachment path".into());
                }

                let dir = self.root.join("work").join(id);

                if dir.exists() {
                    fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
                }

                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

                unpack_tar(&bytes, &dir)?;

                let content =
                    fs::read_to_string(dir.join(attachment)).map_err(|e| e.to_string())?;

                Ok(json!({"report":content}))
            }
            _ => Err("unknown action".into()),
        }
    }

    pub fn serve(&self, listener: TcpListener) -> std::io::Result<()> {
        for incoming in listener.incoming() {
            let stream = incoming?;
            let server = self.clone();
            thread::spawn(move || {
                let _ = server.handle(stream);
            });
        }
        Ok(())
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let (method, path, headers, body) = read_request(&mut stream)?;
        let result: Result<(u16, Vec<u8>), String> = if method == "POST" && path == "/rpc" {
            match serde_json::from_slice(&body)
                .map_err(|e| e.to_string())
                .and_then(|v| self.rpc(v))
            {
                Ok(v) => Ok((
                    200,
                    serde_json::to_vec(&json!({"ok":true,"result":v})).unwrap(),
                )),
                Err(e) => Ok((
                    400,
                    serde_json::to_vec(&json!({"ok":false,"error":e})).unwrap(),
                )),
            }
        } else if method == "PUT" && path.starts_with("/packages/") && path.ends_with("/content") {
            let id = path
                .trim_start_matches("/packages/")
                .trim_end_matches("/content")
                .trim_end_matches('/');

            let token = headers
                .get("authorization")
                .and_then(|x| x.strip_prefix("Bearer "))
                .unwrap_or("");

            let mut s = self.state.lock().unwrap();

            match s.user(token).and_then(|u| {
                let p = s.packages.get_mut(id).ok_or("unknown package")?;
                check_owner(&p.owner, &u)?;
                p.bytes = body;
                Ok(())
            }) {
                Ok(()) => Ok((200, b"{\"ok\":true}".to_vec())),
                Err(e) => Ok((
                    400,
                    serde_json::to_vec(&json!({"ok":false,"error":e})).unwrap(),
                )),
            }
        } else if method == "GET" && path.starts_with("/internal/summaries/") {
            let id = path.trim_start_matches("/internal/summaries/");

            if headers.get("x-importer-key").map(String::as_str) != Some(&self.importer_key) {
                Ok((403, b"forbidden".to_vec()))
            } else {
                let s = self.state.lock().unwrap();

                match s.summaries.get(id) {
                    Some(summary) => Ok((200, summary.content.as_bytes().to_vec())),
                    None => Ok((404, b"not found".to_vec())),
                }
            }
        } else {
            Ok((404, b"not found".to_vec()))
        };

        let (status, bytes) = result.unwrap_or_else(|e| (400, e.into_bytes()));

        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            403 => "Forbidden",
            404 => "Not Found",
            _ => "Error",
        };

        write!(stream,"HTTP/1.1 {status} {status_text}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",bytes.len())?;

        stream.write_all(&bytes)
    }

    fn fetch_bulletin(&self, initial: &str) -> Result<String, String> {
        let mut current = initial.to_owned();
        for _ in 0..5 {
            let (host, port, path) = parse_url(&current)?;

            let addr = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| format!("resolve {host}:{port}: {e}"))?
                .next()
                .ok_or("no address")?;

            let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
                .map_err(|e| format!("connect {addr}: {e}"))?;

            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(|e| format!("set timeout for {addr}: {e}"))?;

            write!(stream,"GET {path} HTTP/1.1\r\nHost: {host}\r\nX-Importer-Key: {}\r\nConnection: close\r\n\r\n",self.importer_key).map_err(|e|e.to_string())?;

            let mut bytes = Vec::new();

            stream
                .read_to_end(&mut bytes)
                .map_err(|e| format!("read response from {addr}: {e}"))?;

            let (status, headers, body) = parse_response(&bytes)?;

            if (300..400).contains(&status) {
                current = headers
                    .get("location")
                    .cloned()
                    .ok_or("redirect without location")?;
                continue;
            }

            if status != 200 {
                return Err(format!("upstream status {status}"));
            }

            return String::from_utf8(body.to_vec()).map_err(|e| e.to_string());
        }
        Err("too many redirects".into())
    }
}

fn safe_relative(p: &Path) -> bool {
    !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

fn validate_safe_tar(bytes: &[u8]) -> Result<(), String> {
    let mut seen = false;
    for entry in tar_entries(bytes)? {
        if !safe_relative(Path::new(&entry.name)) || entry.kind != b'0' {
            return Err("unsafe package".into());
        }
        seen = true;
    }
    if !seen {
        return Err("empty package".into());
    }
    Ok(())
}

fn unpack_tar(bytes: &[u8], dir: &Path) -> Result<(), String> {
    for entry in tar_entries(bytes)? {
        if !safe_relative(Path::new(&entry.name)) {
            return Err("unsafe archive path".into());
        }
        let dest = dir.join(&entry.name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if entry.kind == b'0' {
            fs::write(dest, entry.data).map_err(|e| e.to_string())?;
        } else if entry.kind == b'2' {
            #[cfg(unix)]
            std::os::unix::fs::symlink(entry.link, dest).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            return Err("symlinks require unix".into());
        } else {
            return Err("unsupported tar entry".into());
        }
    }
    Ok(())
}

struct TarEntry<'a> {
    name: String,
    kind: u8,
    link: String,
    data: &'a [u8],
}

fn tar_string(bytes: &[u8]) -> Result<String, String> {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());

    std::str::from_utf8(&bytes[..end])
        .map(str::to_owned)
        .map_err(|e| e.to_string())
}
fn tar_entries(bytes: &[u8]) -> Result<Vec<TarEntry<'_>>, String> {
    let mut entries = Vec::new();

    let mut offset = 0usize;

    while offset + 512 <= bytes.len() {
        let h = &bytes[offset..offset + 512];
        if h.iter().all(|b| *b == 0) {
            break;
        }
        let name = tar_string(&h[..100])?;

        let size_text = tar_string(&h[124..136])?;

        let size = usize::from_str_radix(size_text.trim(), 8).map_err(|_| "invalid tar size")?;

        let kind = if h[156] == 0 { b'0' } else { h[156] };

        let link = tar_string(&h[157..257])?;

        let start = offset + 512;

        let end = start.checked_add(size).ok_or("tar too large")?;

        if end > bytes.len() {
            return Err("truncated tar".into());
        }

        entries.push(TarEntry {
            name,
            kind,
            link,
            data: &bytes[start..end],
        });

        offset = start + size.div_ceil(512) * 512;
    }
    Ok(entries)
}

fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("only http URLs supported")?;

    let (authority, path) = rest
        .split_once('/')
        .map(|(a, p)| (a, format!("/{p}")))
        .unwrap_or((rest, "/".into()));

    if authority.contains('@') || authority.is_empty() {
        return Err("invalid host".into());
    }

    let (host, port) = authority
        .rsplit_once(':')
        .map(|(h, p)| (h, p.parse::<u16>()))
        .unwrap_or((authority, Ok(80)));

    if host.is_empty() {
        return Err("invalid host".into());
    }

    Ok((host.to_owned(), port.map_err(|_| "invalid port")?, path))
}

fn parse_response(bytes: &[u8]) -> Result<HttpResponse<'_>, String> {
    let split = bytes
        .windows(4)
        .position(|x| x == b"\r\n\r\n")
        .ok_or("invalid response")?;

    let head = std::str::from_utf8(&bytes[..split]).map_err(|e| e.to_string())?;

    let mut lines = head.split("\r\n");

    let status = lines
        .next()
        .ok_or("missing status")?
        .split_whitespace()
        .nth(1)
        .ok_or("missing code")?
        .parse::<u16>()
        .map_err(|e| e.to_string())?;

    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();

    Ok((status, headers, &bytes[split + 4..]))
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut data = Vec::new();

    let mut buf = [0u8; 4096];

    let split = loop {
        let n = stream.read(&mut buf)?;

        if n == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }

        data.extend_from_slice(&buf[..n]);

        if data.len() > 2_100_000 {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }

        if let Some(pos) = data.windows(4).position(|x| x == b"\r\n\r\n") {
            break pos;
        }
    };

    let head = std::str::from_utf8(&data[..split])
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;

    let mut lines = head.split("\r\n");

    let first = lines.next().unwrap_or("");

    let mut parts = first.split_whitespace();

    let method = parts
        .next()
        .ok_or(std::io::ErrorKind::InvalidData)?
        .to_owned();

    let path = parts
        .next()
        .ok_or(std::io::ErrorKind::InvalidData)?
        .to_owned();

    let version = parts.next().ok_or(std::io::ErrorKind::InvalidData)?;

    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }

    let headers: HashMap<String, String> = lines
        .filter_map(|x| x.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();

    let len = headers
        .get("content-length")
        .map(|x| x.parse::<usize>())
        .transpose()
        .map_err(|_| std::io::ErrorKind::InvalidData)?
        .unwrap_or(0);

    if len > 2_000_000 {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }

    let start = split + 4;

    while data.len() - start < len {
        let n = stream.read(&mut buf)?;

        if n == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }

        data.extend_from_slice(&buf[..n]);
    }

    Ok((method, path, headers, data[start..start + len].to_vec()))
}