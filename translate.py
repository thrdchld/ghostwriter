import sys
file_path = "/data/data/com.termux/files/home/storage/downloads/1.Project/ghostwaiter/frontend/assets/app.js"
with open(file_path, "r") as f:
    content = f.read()

replacements = {
    'Tolak</button>': 'Reject</button>',
    'Setujui</button>': 'Approve</button>',
    'Hapus</button>': 'Delete</button>',
    'Edit</button>': 'Edit</button>',
}

for k, v in replacements.items():
    content = content.replace(k, v)

with open(file_path, "w") as f:
    f.write(content)
