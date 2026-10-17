// Shared by the isolated content script and extension modules; no remote config.
Object.defineProperty(globalThis, "GMIS_CATALOG", {value: Object.freeze({
  labour: Object.freeze({label: "劳动实践", page: "/student/yggl/zyzfwbm",
    available: "zyzfwbm_sqlist", enrolled: "zyzfwbm_cklist", submit: "xshdbm_bm", preflight: null}),
  academic: Object.freeze({label: "学术报告", page: "/student/yggl/xshdbm",
    available: "xshdbm_sqlist", enrolled: "xshdbm_cklist", submit: "xshdbm_bm", preflight: "xshdbm_sfkysq"})
}), configurable: false, writable: false});
