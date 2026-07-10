package agent

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/henrygd/beszel/internal/entities/systemd"
)

func TestParseCheckItem(t *testing.T) {
	cases := []struct {
		in                    string
		name, port, nacosName string
	}{
		{"app-a.jar:8080", "app-a.jar", "8080", ""},
		{"app-b.jar:9090@svc-b", "app-b.jar", "9090", "svc-b"},
		{"app-c.jar", "app-c.jar", "", ""},
		{"mysql:3306", "mysql", "3306", ""},
		{" redis : 6379 ", "redis", "6379", ""},
	}
	for _, c := range cases {
		got := parseCheckItem(c.in)
		if got.name != c.name || got.port != c.port || got.nacosName != c.nacosName {
			t.Errorf("parseCheckItem(%q) = %+v, want name=%q port=%q nacos=%q", c.in, got, c.name, c.port, c.nacosName)
		}
	}
}

func TestNewSvcCheckManagerFromEnv(t *testing.T) {
	os.Setenv("CHECK_SERVICES", "app-a.jar:8080,app-b.jar@svc-b")
	os.Setenv("CHECK_MIDDLEWARE", "mysql:3306")
	os.Setenv("NACOS_URL", "http://127.0.0.1:8848/")
	defer func() {
		os.Unsetenv("CHECK_SERVICES")
		os.Unsetenv("CHECK_MIDDLEWARE")
		os.Unsetenv("NACOS_URL")
	}()
	m := newSvcCheckManager()
	if m == nil {
		t.Fatal("expected manager, got nil")
	}
	if len(m.targets) != 3 {
		t.Fatalf("expected 3 targets, got %d", len(m.targets))
	}
	// jar 默认 nacos 服务名 = 去掉 .jar
	if m.targets[0].nacosName != "app-a" {
		t.Errorf("expected default nacos name app-a, got %q", m.targets[0].nacosName)
	}
	if m.targets[1].nacosName != "svc-b" {
		t.Errorf("expected nacos name svc-b, got %q", m.targets[1].nacosName)
	}
	// 中间件永不查 nacos
	if m.targets[2].nacosName != "" {
		t.Errorf("middleware should not have nacos check, got %q", m.targets[2].nacosName)
	}
	if m.nacosURL != "http://127.0.0.1:8848" {
		t.Errorf("nacos url not trimmed: %q", m.nacosURL)
	}
}

func TestNewSvcCheckManagerDisabled(t *testing.T) {
	os.Unsetenv("CHECK_SERVICES")
	os.Unsetenv("CHECK_MIDDLEWARE")
	if m := newSvcCheckManager(); m != nil {
		t.Fatal("expected nil manager when no env set")
	}
}

func TestPortListening(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	if !portListening(port) {
		t.Errorf("expected port %s to be listening", port)
	}
	if portListening("1") {
		t.Error("expected port 1 to not be listening")
	}
}

func TestFindProcess(t *testing.T) {
	procs := []procEntry{
		{cmdline: "java -jar /data/apps/app-a.jar --server.port=8080", rss: 1024},
		{cmdline: "/usr/sbin/mysqld --datadir=/var/lib/mysql", rss: 2048},
	}
	if rss, ok := findProcess(procs, "app-a.jar"); !ok || rss != 1024 {
		t.Errorf("expected to find app-a.jar with rss 1024, got ok=%v rss=%d", ok, rss)
	}
	if _, ok := findProcess(procs, "mysqld"); !ok {
		t.Error("expected to find mysqld")
	}
	if _, ok := findProcess(procs, "not-exist.jar"); ok {
		t.Error("expected not to find not-exist.jar")
	}
}

func TestNacosHealthy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("serviceName")
		switch name {
		case "healthy-local":
			// 本机回环地址 127.0.0.1 一定在 localIPs 里
			w.Write([]byte(`{"hosts":[{"ip":"127.0.0.1","healthy":true}]}`))
		case "unhealthy-local":
			w.Write([]byte(`{"hosts":[{"ip":"127.0.0.1","healthy":false},{"ip":"10.99.99.99","healthy":true}]}`))
		case "healthy-remote-only":
			w.Write([]byte(`{"hosts":[{"ip":"10.99.99.99","healthy":true}]}`))
		default:
			w.Write([]byte(`{"hosts":[]}`))
		}
	}))
	defer server.Close()

	m := &svcCheckManager{nacosURL: server.URL, group: "DEFAULT_GROUP", client: server.Client()}
	// server.URL 是 /nacos 前缀之外的裸地址，nacosHealthy 会拼 /nacos/v1/...，
	// httptest 对任意 path 都走同一 handler，无需处理前缀。
	if ok, err := m.nacosHealthy("healthy-local"); err != nil || !ok {
		t.Errorf("healthy-local: want ok, got ok=%v err=%v", ok, err)
	}
	// 本机实例存在但不健康 → 失败，即使远端有健康实例
	if ok, _ := m.nacosHealthy("unhealthy-local"); ok {
		t.Error("unhealthy-local: want fail")
	}
	// 列表里没有本机 IP → 退化为任一健康实例通过
	if ok, _ := m.nacosHealthy("healthy-remote-only"); !ok {
		t.Error("healthy-remote-only: want ok (fallback)")
	}
	if ok, _ := m.nacosHealthy("no-instance"); ok {
		t.Error("no-instance: want fail")
	}
}

func TestRunProducesPseudoServices(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	m := &svcCheckManager{targets: []svcCheckTarget{{name: "definitely-not-running.jar", port: port}}}
	results := m.run()
	if len(results) != 2 {
		t.Fatalf("expected 2 checks (process+port), got %d", len(results))
	}
	byName := map[string]*systemd.Service{}
	for _, svc := range results {
		byName[svc.Name] = svc
	}
	proc := byName["definitely-not-running.jar [进程]"]
	if proc == nil || proc.State != systemd.StatusFailed {
		t.Errorf("process check should fail: %+v", proc)
	}
	var portSvc *systemd.Service
	for name, svc := range byName {
		if strings.Contains(name, "[端口:") {
			portSvc = svc
		}
	}
	if portSvc == nil || portSvc.State != systemd.StatusActive {
		t.Errorf("port check should pass: %+v", portSvc)
	}
}
