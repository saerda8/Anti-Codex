#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:TRANSLATOR_URL) {
    $env:TRANSLATOR_URL.TrimEnd("/")
    exit 0
}
if ($env:ANTICODEX_LOCAL_ADDRESS) {
    "http://$($env:ANTICODEX_LOCAL_ADDRESS):8484"
    exit 0
}

"http://127.0.0.1:8484"
