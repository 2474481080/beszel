package agent

// svccheck.go：必检服务巡检（二改功能）。通过环境变量声明本机必须存活的
// 业务 jar 与数据库/中间件，agent 在每轮默认采集里做检查，并把结果作为
// “伪 systemd 服务”合入服务上报管道 —— hub 与前端零改动即可在 Services
// 页看到每一项，失败会计入 Info.Services 的失败数并触发已有的服务告警。
//
// 环境变量（均不设置时不做任何额外检查，行为与原版一致）：
//   CHECK_SERVICES    业务 jar，逗号分隔：jar名[:端口][@nacos服务名]
//                     检查项 = 进程 + 端口(若给) + nacos 注册健康(若配了 NACOS_URL)
//                     nacos 服务名缺省为 jar 名去掉 .jar 后缀
//   CHECK_MIDDLEWARE  数据库/中间件，逗号分隔：名称[:端口]，只查 进程 + 端口
//   NACOS_URL         如 http://10.0.0.5:8848；可选 NACOS_GROUP（默认 DEFAULT_GROUP）、
//                     NACOS_NAMESPACE、NACOS_USERNAME/NACOS_PASSWORD（开了鉴权时）

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/henrygd/beszel/agent/utils"
	"github.com/henrygd/beszel/internal/entities/systemd"
	"github.com/shirou/gopsutil/v4/process"
)

type svcCheckTarget struct {
	name      string // 显示名 / 进程匹配串（jar 名或中间件名）
	port      string // 可选，必检监听端口
	nacosName string // 仅业务 jar：nacos 服务名；空表示不查 nacos
}

type svcCheckManager struct {
	targets  []svcCheckTarget
	nacosURL string
	group    string
	nsID     string
	user     string
	pass     string
	client   *http.Client
	localIPs map[string]struct{}
}

// newSvcCheckManager 解析环境变量；没配 CHECK_SERVICES / CHECK_MIDDLEWARE 时返回 nil。
func newSvcCheckManager() *svcCheckManager {
	services, _ := utils.GetEnv("CHECK_SERVICES")
	middleware, _ := utils.GetEnv("CHECK_MIDDLEWARE")
	if strings.TrimSpace(services) == "" && strings.TrimSpace(middleware) == "" {
		return nil
	}
	m := &svcCheckManager{client: &http.Client{Timeout: 5 * time.Second}}
	m.nacosURL, _ = utils.GetEnv("NACOS_URL")
	m.nacosURL = strings.TrimRight(strings.TrimSpace(m.nacosURL), "/")
	m.group, _ = utils.GetEnv("NACOS_GROUP")
	if m.group == "" {
		m.group = "DEFAULT_GROUP"
	}
	m.nsID, _ = utils.GetEnv("NACOS_NAMESPACE")
	m.user, _ = utils.GetEnv("NACOS_USERNAME")
	m.pass, _ = utils.GetEnv("NACOS_PASSWORD")

	for _, item := range splitTrim(services) {
		target := parseCheckItem(item)
		if target.name == "" {
			continue
		}
		if m.nacosURL != "" && target.nacosName == "" {
			target.nacosName = strings.TrimSuffix(target.name, ".jar")
		} else if m.nacosURL == "" {
			target.nacosName = ""
		}
		m.targets = append(m.targets, target)
	}
	for _, item := range splitTrim(middleware) {
		target := parseCheckItem(item)
		if target.name == "" {
			continue
		}
		target.nacosName = "" // 中间件/数据库只查进程和端口
		m.targets = append(m.targets, target)
	}
	if len(m.targets) == 0 {
		return nil
	}
	slog.Info("Service checks enabled", "targets", len(m.targets), "nacos", m.nacosURL != "")
	return m
}

// parseCheckItem 解析 名称[:端口][@nacos服务名]
func parseCheckItem(item string) (t svcCheckTarget) {
	if at := strings.Index(item, "@"); at >= 0 {
		t.nacosName = strings.TrimSpace(item[at+1:])
		item = item[:at]
	}
	if colon := strings.LastIndex(item, ":"); colon >= 0 {
		t.port = strings.TrimSpace(item[colon+1:])
		item = item[:colon]
	}
	t.name = strings.TrimSpace(item)
	return t
}

func splitTrim(value string) []string {
	parts := []string{}
	for _, p := range strings.Split(value, ",") {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

// run 执行全部检查，返回伪服务列表（每个检查项一条）。
func (m *svcCheckManager) run() []*systemd.Service {
	procs := m.snapshotProcesses()
	results := make([]*systemd.Service, 0, len(m.targets)*3)
	add := func(name string, ok bool, memRSS uint64) {
		svc := &systemd.Service{Name: name, State: systemd.StatusActive, Sub: systemd.SubStateRunning, Mem: memRSS}
		if !ok {
			svc.State = systemd.StatusFailed
			svc.Sub = systemd.SubStateFailed
		}
		results = append(results, svc)
	}
	for _, t := range m.targets {
		rss, found := findProcess(procs, t.name)
		add(t.name+" [进程]", found, rss)
		if t.port != "" {
			add(t.name+" [端口:"+t.port+"]", portListening(t.port), 0)
		}
		if t.nacosName != "" {
			ok, err := m.nacosHealthy(t.nacosName)
			if err != nil {
				slog.Debug("nacos check", "service", t.nacosName, "err", err)
			}
			add(t.name+" [nacos]", ok, 0)
		}
	}
	return results
}

type procEntry struct {
	cmdline string
	rss     uint64
}

func (m *svcCheckManager) snapshotProcesses() []procEntry {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	entries := make([]procEntry, 0, len(procs))
	for _, p := range procs {
		cmdline, err := p.Cmdline()
		if err != nil || cmdline == "" {
			continue
		}
		var rss uint64
		if mem, err := p.MemoryInfo(); err == nil && mem != nil {
			rss = mem.RSS
		}
		entries = append(entries, procEntry{cmdline: cmdline, rss: rss})
	}
	return entries
}

// findProcess 命令行包含目标名即视为在跑（jar 名 / 中间件进程名）。
func findProcess(procs []procEntry, name string) (rss uint64, found bool) {
	for _, p := range procs {
		if strings.Contains(p.cmdline, name) {
			return p.rss, true
		}
	}
	return 0, false
}

func portListening(port string) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// ---------------------------------------------------------------------------
// nacos

type nacosInstanceList struct {
	Hosts []struct {
		IP      string `json:"ip"`
		Healthy bool   `json:"healthy"`
	} `json:"hosts"`
}

// nacosHealthy 查询服务实例列表：优先要求本机 IP 的实例健康；
// 若列表里根本没有本机 IP（如容器网络注册），退化为存在任一健康实例即通过。
func (m *svcCheckManager) nacosHealthy(serviceName string) (bool, error) {
	query := url.Values{}
	query.Set("serviceName", serviceName)
	query.Set("groupName", m.group)
	if m.nsID != "" {
		query.Set("namespaceId", m.nsID)
	}
	if token, err := m.nacosToken(); err == nil && token != "" {
		query.Set("accessToken", token)
	}
	resp, err := m.client.Get(m.nacosURL + "/nacos/v1/ns/instance/list?" + query.Encode())
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("nacos %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var list nacosInstanceList
	if err := json.Unmarshal(body, &list); err != nil {
		return false, err
	}
	localSeen := false
	for _, host := range list.Hosts {
		if m.isLocalIP(host.IP) {
			localSeen = true
			if host.Healthy {
				return true, nil
			}
		}
	}
	if localSeen {
		return false, nil
	}
	for _, host := range list.Hosts {
		if host.Healthy {
			return true, nil
		}
	}
	return false, nil
}

// nacosToken 开了鉴权时登录换 accessToken；未配用户名则跳过。
func (m *svcCheckManager) nacosToken() (string, error) {
	if m.user == "" {
		return "", nil
	}
	form := url.Values{"username": {m.user}, "password": {m.pass}}
	resp, err := m.client.PostForm(m.nacosURL+"/nacos/v1/auth/login", form)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var result struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	return result.AccessToken, nil
}

func (m *svcCheckManager) isLocalIP(ip string) bool {
	if m.localIPs == nil {
		m.localIPs = map[string]struct{}{}
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, addr := range addrs {
				if ipNet, ok := addr.(*net.IPNet); ok {
					m.localIPs[ipNet.IP.String()] = struct{}{}
				}
			}
		}
	}
	_, ok := m.localIPs[ip]
	return ok
}
