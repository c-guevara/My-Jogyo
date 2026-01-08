# Gyoshu Examples

This directory contains worked examples demonstrating Gyoshu's research automation capabilities.

## Available Examples

| Example | Type | Data Source | Key Features |
|---------|------|-------------|--------------|
| [Binance Futures EDA](binance-futures-eda.png) | Exploratory Data Analysis | Binance API | 3D visualizations, correlation analysis, volatility surfaces |

## Running Examples

### Prerequisites

1. **Install Gyoshu** following the [main README](../README.md)
2. **Set up Python environment**:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate  # or .venv\Scripts\activate on Windows
   pip install pandas numpy matplotlib seaborn scikit-learn
   ```
3. **Configure data sources** (if needed):
   - Kaggle: Set up `~/.kaggle/kaggle.json` with API credentials

### Quick Start

```bash
# Navigate to a new directory
mkdir my-research && cd my-research

# Set up environment
python3 -m venv .venv
source .venv/bin/activate
pip install pandas numpy matplotlib seaborn

# Run any of these examples:

# 1. Binance Futures EDA (API or local data)
/gyoshu-auto perform comprehensive EDA on binance futures data

# 2. Titanic Classification (sklearn built-in)
/gyoshu-auto analyze Titanic survival data and build classification model

# 3. Iris Clustering (no download needed)
/gyoshu-auto cluster iris dataset and visualize results
```

## Example Structure

Each example directory contains:

```
XX-example-name/
├── README.md       # What the example shows, how to run it
├── prompt.md       # Exact /gyoshu-auto command used
├── notebook.ipynb  # Generated Jupyter notebook (cleaned)
└── figures/        # Key output visualizations
```

> **Note**: Raw data files are NOT included due to size. Each example documents how to obtain the data.

## Contributing Examples

Want to add your own example? Follow this structure:

1. Create a new directory: `examples/NN-descriptive-name/`
2. Include:
   - `README.md` - What it demonstrates, prerequisites, how to run
   - `prompt.md` - The exact prompt used
   - `notebook.ipynb` - Cleaned notebook (remove large outputs)
   - `figures/` - 3-5 representative figures
3. Update this README with a new row in the table

### Cleaning Notebooks

To reduce notebook size for git:

```python
import json

# Load notebook
with open('notebook.ipynb') as f:
    nb = json.load(f)

# Remove large outputs
for cell in nb['cells']:
    if cell['cell_type'] == 'code':
        for output in cell.get('outputs', []):
            if 'data' in output and 'image/png' in output['data']:
                output['data'] = {'text/plain': ['[Image - see figures/]']}

# Save cleaned
with open('notebook_cleaned.ipynb', 'w') as f:
    json.dump(nb, f, indent=1)
```

## Suggested Future Examples

| Example | Type | Dataset | What It Would Show |
|---------|------|---------|-------------------|
| Titanic Survival | Classification | Kaggle | Feature engineering, model comparison |
| House Prices | Regression | Kaggle | Advanced feature engineering |
| MNIST Digits | Deep Learning | torchvision | Neural network training |
| Stock Prediction | Time Series | Yahoo Finance | Time-aware analysis |
| Sentiment Analysis | NLP | Movie reviews | Text processing pipeline |
