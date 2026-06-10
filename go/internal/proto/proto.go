package proto

const (
	DefaultBlockSize = 4 * 1024 * 1024 // 4 MiB
	HashHexLen       = 64              // sha256 hex
)

type BlockInfo struct {
	Index  int    `json:"index"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
}

type Manifest struct {
	Name      string      `json:"name"`
	Size      int64       `json:"size"`
	SHA256    string      `json:"sha256"`
	BlockSize int         `json:"block_size"`
	Blocks    []BlockInfo `json:"blocks"`
}

type InitResponse struct {
	Missing []int `json:"missing"`
}

type FileEntry struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	State     string `json:"state"`
	UpdatedAt int64  `json:"updated_at"`
}

type CommitResponse struct {
	OK bool `json:"ok"`
}
