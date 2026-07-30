"""Aggregator type choices for Feed models."""

AGGREGATOR_CHOICES = [
    # Custom aggregators (default first)
    ("full_website", "Full Website"),
    ("feed_content", "Feed Content (RSS/Atom)"),
    # Managed aggregators
    ("heise", "Heise"),
    ("merkur", "Merkur"),
    ("tagesschau", "Tagesschau"),
    ("explosm", "Explosm"),
    ("dark_legacy", "Dark Legacy Comics"),
    ("caschys_blog", "Caschy's Blog"),
    ("mactechnews", "MacTechNews"),
    ("oglaf", "Oglaf"),
    ("mein_mmo", "Mein-MMO"),
    ("the_verge", "The Verge"),
    ("ars_technica", "Ars Technica"),
    # Social aggregators
    ("youtube", "YouTube"),
    ("reddit", "Reddit"),
    ("podcast", "Podcast"),
]
