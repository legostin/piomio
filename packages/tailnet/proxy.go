// The proxies behind the Funnel listeners: plain HTTP to the hub's loopback gateways, with the client's real address.

package main

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httputil"
	"time"

	"tailscale.com/ipn"
)

type clientIPKey struct{}

// alpn is what the listeners offer: HTTP/2 loads the page's files over one connection, where HTTP/1.1 opens up to six,
// each with its own TLS handshake through the tunnel. A browser's WebSocket takes a connection of its own over HTTP/1.1.
var alpn = []string{"h2", "http/1.1"}

// clientIP is the address of whoever opened the connection: Funnel's original client, else the tailnet peer.
func clientIP(c net.Conn) string {
	if t, ok := c.(*tls.Conn); ok {
		c = t.NetConn()
	}
	if f, ok := c.(*ipn.FunnelConn); ok && f.Src.IsValid() {
		return f.Src.Addr().String()
	}
	if host, _, err := net.SplitHostPort(c.RemoteAddr().String()); err == nil {
		return host
	}
	return c.RemoteAddr().String()
}

func withClientIP(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, clientIPKey{}, clientIP(c))
}

// newProxy forwards to target (host:port) over HTTP, WebSockets included. The Host header stays the link's, and the
// forwarded headers are set here only: ReverseProxy drops whatever the client sent before Rewrite runs.
func newProxy(target string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = target
			r.Out.Host = r.In.Host
			r.Out.Header.Del("Forwarded")
			if ip, _ := r.In.Context().Value(clientIPKey{}).(string); ip != "" {
				r.Out.Header.Set("X-Forwarded-For", ip)
			}
			r.Out.Header.Set("X-Forwarded-Proto", "https")
			r.Out.Header.Set("X-Forwarded-Host", r.In.Host)
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Piomio is not answering on this computer right now.", http.StatusBadGateway)
		},
	}
}

func serveProxy(ln net.Listener, target string) *http.Server {
	srv := &http.Server{Handler: newProxy(target), ConnContext: withClientIP, ReadHeaderTimeout: 30 * time.Second}
	go srv.Serve(ln)
	return srv
}
