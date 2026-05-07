package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"minidss/internal/chunk"
	"minidss/internal/proto"
)

func main() {
	coord := flag.String("coordinator", envOr("MINIDSS_COORDINATOR", "http://127.0.0.1:9981"),
		"coordinator URL")
	blockSize := flag.Int("block-size", proto.DefaultBlockSize, "upload block size in bytes")
	flag.Usage = usage
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}

	c := &Client{
		Base: *coord,
		HTTP: &http.Client{Timeout: 10 * time.Minute},
		BlockSize: *blockSize,
	}

	var err error
	switch args[0] {
	case "upload":
		if len(args) < 2 {
			usage()
			os.Exit(2)
		}
		name := filepath.Base(args[1])
		if len(args) >= 3 {
			name = args[2]
		}
		err = c.Upload(args[1], name)
	case "download":
		if len(args) < 2 {
			usage()
			os.Exit(2)
		}
		out := args[1]
		if len(args) >= 3 {
			out = args[2]
		}
		err = c.Download(args[1], out)
	case "ls":
		err = c.List()
	case "rm":
		if len(args) < 2 {
			usage()
			os.Exit(2)
		}
		err = c.Delete(args[1])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: dssctl [-coordinator URL] [-block-size N] <command> [args]

commands:
  upload <localpath> [remotename]
  download <remotename> [localpath]
  ls
  rm <remotename>

env:
  MINIDSS_COORDINATOR  override default coordinator URL`)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type Client struct {
	Base      string
	HTTP      *http.Client
	BlockSize int
}

func (c *Client) Upload(localPath, remoteName string) error {
	chk := chunk.New(c.BlockSize)
	m, err := chk.Manifest(localPath, remoteName)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}

	body, _ := json.Marshal(m)
	resp, err := c.HTTP.Post(c.urlf("/v1/files/%s/init", remoteName),
		"application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("init: %s: %s", resp.Status, b)
	}
	var ir proto.InitResponse
	if err := json.NewDecoder(resp.Body).Decode(&ir); err != nil {
		return fmt.Errorf("decode init: %w", err)
	}

	if len(ir.Missing) == 0 {
		fmt.Println("all blocks already present")
	} else {
		fmt.Printf("uploading %d/%d block(s) (%d MiB block size)\n",
			len(ir.Missing), len(m.Blocks), m.BlockSize/(1024*1024))
		f, err := os.Open(localPath)
		if err != nil {
			return err
		}
		defer f.Close()

		need := make(map[int]bool, len(ir.Missing))
		for _, i := range ir.Missing {
			need[i] = true
		}
		for _, b := range m.Blocks {
			if !need[b.Index] {
				continue
			}
			if err := c.uploadOneBlock(f, remoteName, b, m.BlockSize); err != nil {
				return fmt.Errorf("block %d: %w", b.Index, err)
			}
			fmt.Printf("  block %d/%d uploaded (%d bytes)\n", b.Index+1, len(m.Blocks), b.Size)
		}
	}

	cm, err := c.HTTP.Post(c.urlf("/v1/files/%s/commit", remoteName), "application/json", nil)
	if err != nil {
		return err
	}
	defer cm.Body.Close()
	if cm.StatusCode/100 != 2 {
		b, _ := io.ReadAll(cm.Body)
		return fmt.Errorf("commit: %s: %s", cm.Status, b)
	}
	fmt.Printf("uploaded %s (%d bytes, sha256=%s)\n", remoteName, m.Size, m.SHA256)
	return nil
}

func (c *Client) uploadOneBlock(f *os.File, remoteName string, b proto.BlockInfo, blockSize int) error {
	buf := make([]byte, b.Size)
	offset := int64(b.Index) * int64(blockSize)
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return err
	}
	u := c.urlf("/v1/files/%s/blocks/%d", remoteName, b.Index)
	req, err := http.NewRequest(http.MethodPut, u, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(buf))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("%s: %s", resp.Status, body)
	}
	return nil
}

func (c *Client) Download(remoteName, localPath string) error {
	resp, err := c.HTTP.Get(c.urlf("/v1/files/%s", remoteName))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("get: %s: %s", resp.Status, b)
	}
	out, err := os.OpenFile(localPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	n, err := io.Copy(out, resp.Body)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d bytes to %s\n", n, localPath)
	return nil
}

func (c *Client) List() error {
	resp, err := c.HTTP.Get(c.urlf("/v1/files"))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("ls: %s", resp.Status)
	}
	var files []proto.FileEntry
	if err := json.NewDecoder(resp.Body).Decode(&files); err != nil {
		return err
	}
	if len(files) == 0 {
		fmt.Println("(empty)")
		return nil
	}
	fmt.Printf("%-32s %-12s %-10s %s\n", "NAME", "SIZE", "STATE", "SHA256")
	for _, f := range files {
		sha := f.SHA256
		if len(sha) > 16 {
			sha = sha[:16] + "..."
		}
		fmt.Printf("%-32s %-12s %-10s %s\n", f.Name,
			strconv.FormatInt(f.Size, 10), f.State, sha)
	}
	return nil
}

func (c *Client) Delete(remoteName string) error {
	req, _ := http.NewRequest(http.MethodDelete, c.urlf("/v1/files/%s", remoteName), nil)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("delete: %s: %s", resp.Status, b)
	}
	fmt.Printf("deleted %s\n", remoteName)
	return nil
}

func (c *Client) urlf(format string, parts ...any) string {
	escaped := make([]any, len(parts))
	for i, p := range parts {
		switch v := p.(type) {
		case string:
			escaped[i] = url.PathEscape(v)
		default:
			escaped[i] = v
		}
	}
	return c.Base + fmt.Sprintf(format, escaped...)
}
