from fastapi import FastAPI

app = FastAPI(title="glofas-fetcher")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}
