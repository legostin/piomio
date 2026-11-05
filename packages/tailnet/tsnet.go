// The real backend: a tsnet node in this process, with Funnel listeners in front of the hub's gateways.

package main

import (
	"context"
	"crypto/tls"
	"net/http"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

type tsBackend struct {
	srv     *tsnet.Server
	lc      *local.Client
	start   Start
	servers []*http.Server
}

func (t *tsBackend) Status(ctx context.Context) (*ipnstate.Status, error) {
	return t.lc.StatusWithoutPeers(ctx)
}

func (t *tsBackend) QueryFunnel(ctx context.Context) (*tailcfg.QueryFeatureResponse, error) {
	return t.lc.QueryFeature(ctx, "funnel")
}

func (t *tsBackend) StartLogin(ctx context.Context) error {
	return t.lc.StartLoginInteractive(ctx)
}

func (t *tsBackend) Listen() error {
	cert, err := tls.X509KeyPair([]byte(t.start.DeviceCert), []byte(t.start.DeviceKey))
	if err != nil {
		return err
	}
	web, err := t.srv.ListenFunnel("tcp", ":443", tsnet.FunnelTLSConfig(&tls.Config{GetCertificate: t.lc.GetCertificate, NextProtos: alpn}))
	if err != nil {
		return err
	}
	// Phones pin the hub's own certificate: the same one here as on the home Wi-Fi.
	device, err := t.srv.ListenFunnel("tcp", ":8443", tsnet.FunnelTLSConfig(&tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: alpn}))
	if err != nil {
		web.Close()
		return err
	}
	t.servers = append(t.servers, serveProxy(web, t.start.Web), serveProxy(device, t.start.Device))
	return nil
}

func (t *tsBackend) Close() {
	for _, s := range t.servers {
		s.Close()
	}
	t.srv.Close()
}
